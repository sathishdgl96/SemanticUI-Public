r"""Parse the MDX Excel's pivot engine writes, into query-able parts.

This is not an MDX implementation. It is a parser for the statements one
client -- Excel's MSOLAP provider -- actually sends, captured on the wire:

    SELECT FROM [cube] WHERE ([Measures].[X]) CELL PROPERTIES VALUE, ...
    SELECT NON EMPTY Hierarchize(AddCalculatedMembers({DrilldownLevel(
        {[T].[F].[All]})})) DIMENSION PROPERTIES PARENT_UNIQUE_NAME,
        HIERARCHY_UNIQUE_NAME ON COLUMNS FROM [cube] CELL PROPERTIES ...
    SELECT {[Measures].[X],[Measures].[Y]} ... ON COLUMNS,
        NON EMPTY CrossJoin(...) ON ROWS FROM [cube] WHERE (...)
    ... FROM (SELECT ({[T].[F].&[v],...}) ON COLUMNS FROM [cube])  (filters)

Set functions are recognised structurally, not evaluated: Hierarchize and
AddCalculatedMembers pass through, DrilldownLevel({All}) marks "the All
member plus its children", CrossJoin concatenates hierarchy specs on one
axis. Anything outside the subset raises MdxUnsupported with the offending
construct named, so the wire trace shows exactly what to add next.
"""

from dataclasses import dataclass, field


class MdxUnsupported(Exception):
    pass


# ---------------------------------------------------------------- tokenizer

@dataclass
class Tok:
    kind: str   # name | word | punct
    value: object


def tokenize(text: str) -> list[Tok]:
    out: list[Tok] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif c == "[":
            j = i + 1
            parts = []
            while True:
                k = text.index("]", j)
                # ]] escapes a literal ] inside a name
                if k + 1 < n and text[k + 1] == "]":
                    parts.append(text[j:k + 1])
                    j = k + 2
                else:
                    parts.append(text[j:k])
                    break
            out.append(Tok("name", "".join(parts)))
            i = k + 1
        elif c in "(){},*&-":
            out.append(Tok("punct", c))
            i += 1
        elif c == ".":
            out.append(Tok("punct", "."))
            i += 1
        elif c.isalnum() or c == "_":
            j = i
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            out.append(Tok("word", text[i:j].upper()))
            i = j
        else:
            raise MdxUnsupported(f"unexpected character {c!r}")
    return out


# ------------------------------------------------------------------- model

@dataclass
class MemberRef:
    """A bracketed path like [ORDERS].[ORDER_STATUS].&[F] or
    [Measures].[ORDERS.TOTAL_ORDER_VALUE], possibly with a trailing
    function word such as CHILDREN."""
    parts: list[str]
    keyed: list[bool]
    suffix: str | None = None

    @property
    def is_measure(self) -> bool:
        return bool(self.parts) and self.parts[0].upper() == "MEASURES"


@dataclass
class HierSpec:
    """What one hierarchy contributes to an axis."""
    kind: str                    # "measures" | "drill" | "members"
    measures: list[str] = field(default_factory=list)
    table: str = ""
    hier_field: str = ""
    include_all: bool = True     # drill/members: include the All member
    members: list[str] = field(default_factory=list)  # explicit leaf keys
    children_of_all: bool = False  # drill: include the All member's children
    #: Collapse support: when set, this hierarchy's LEAF members appear only
    #: under parent members that pass the constraint. `parent_key` names the
    #: constraining hierarchy ((TABLE, FIELD) uppercased); exclude lists the
    #: parents that stay collapsed, include (when not None) the only parents
    #: that expand.
    parent_key: tuple | None = None
    parent_exclude: list[str] = field(default_factory=list)
    parent_include: list[str] | None = None
    #: USER hierarchies (kind "userhier"): a drill path over several fields.
    #: `levels` is [(table, field), ...]; members are value PATHS. A path in
    #: `drilled_paths` shows its children; `drilled_depths` marks whole
    #: depths drilled (the except-form collapse), minus `undrilled_paths`.
    levels: list = field(default_factory=list)
    drilled_paths: set = field(default_factory=set)
    undrilled_paths: set = field(default_factory=set)
    drilled_depths: set = field(default_factory=set)
    member_paths: list = field(default_factory=list)


@dataclass
class MdxQuery:
    cube: str = ""
    axes: list = field(default_factory=list)   # index 0 = COLUMNS
    slicer: list = field(default_factory=list)  # MemberRefs from WHERE
    subselect_filters: list = field(default_factory=list)  # MemberRef lists
    cell_properties: list = field(default_factory=list)


# ------------------------------------------------------------------ parser

class _Parser:
    def __init__(self, toks: list[Tok]):
        self.toks = toks
        self.i = 0

    def peek(self, offset=0) -> Tok | None:
        j = self.i + offset
        return self.toks[j] if j < len(self.toks) else None

    def next(self) -> Tok:
        tok = self.toks[self.i]
        self.i += 1
        return tok

    def accept_word(self, *words) -> bool:
        t = self.peek()
        if t and t.kind == "word" and t.value in words:
            self.i += 1
            return True
        return False

    def expect_word(self, word):
        if not self.accept_word(word):
            raise MdxUnsupported(f"expected {word}, at {self.peek()}")

    def expect_punct(self, ch):
        t = self.next()
        if t.kind != "punct" or t.value != ch:
            raise MdxUnsupported(f"expected {ch!r}, got {t}")

    # -- member references ------------------------------------------------
    def parse_member(self) -> MemberRef:
        parts, keyed = [], []
        while True:
            t = self.peek()
            if t and t.kind == "punct" and t.value == "&":
                self.i += 1
                t = self.peek()
                if not t or t.kind != "name":
                    raise MdxUnsupported("expected [name] after &")
                parts.append(self.next().value)
                keyed.append(True)
            elif t and t.kind == "name":
                parts.append(self.next().value)
                keyed.append(False)
            elif t and t.kind == "word":
                # trailing function word: .Children, .Members
                return MemberRef(parts, keyed, suffix=self.next().value)
            else:
                raise MdxUnsupported(f"expected member part, got {t}")
            t = self.peek()
            if t and t.kind == "punct" and t.value == ".":
                self.i += 1
                continue
            return MemberRef(parts, keyed)

    # -- set expressions --------------------------------------------------
    PASSTHROUGH = {"HIERARCHIZE", "ADDCALCULATEDMEMBERS", "UNION", "DISTINCT"}

    def parse_set(self) -> list:
        """A set expression -> list of MemberRef / ('drill', MemberRef) /
        ('cross', [specs...]) entries, flattened later."""
        t = self.peek()
        if t is None:
            raise MdxUnsupported("unexpected end of statement in set")
        if t.kind == "word" and t.value in self.PASSTHROUGH:
            self.next()
            self.expect_punct("(")
            inner = self.parse_set()
            # Union(a, b): additional arguments merge in
            while self.peek() and self.peek().kind == "punct" and self.peek().value == ",":
                self.next()
                inner += self.parse_set()
            self.expect_punct(")")
            return inner
        if t.kind == "punct" and t.value == "-":
            # Unary set complement, Excel's collapse idiom: {-{m}} inside a
            # DrilldownMember means "every member EXCEPT these".
            self.next()
            inner = self.parse_set()
            return [("except", inner)]
        if t.kind == "word" and t.value == "EXISTS":
            # Exists(setA, setB): the members of A that have data alongside
            # B's members -- how Excel scopes a filter-dropdown level to the
            # member the user just expanded.
            self.next()
            self.expect_punct("(")
            base = self.parse_set()
            self.expect_punct(",")
            among = self.parse_set()
            self.expect_punct(")")
            return [("exists", base, among)]
        if t.kind == "word" and t.value == "DRILLDOWNMEMBER":
            # DrilldownMember(base, drillSet [, RECURSIVE | hierarchy]):
            # base supplies the tuples, drillSet says which parent members
            # expand, the optional hierarchy is what they expand INTO.
            self.next()
            self.expect_punct("(")
            base = self.parse_set()
            self.expect_punct(",")
            drill = self.parse_set()
            target: list = []
            while self.peek() and self.peek().kind == "punct" and self.peek().value == ",":
                self.next()
                if self.accept_word("RECURSIVE"):
                    continue
                target = self.parse_set()
            self.expect_punct(")")
            return [("drillmember", base, drill, target)]
        if t.kind == "word" and t.value == "DRILLDOWNLEVEL":
            self.next()
            self.expect_punct("(")
            inner = self.parse_set()
            self.expect_punct(")")
            return [("drill", m) for m in inner]
        if t.kind == "word" and t.value in ("CROSSJOIN", "NONEMPTYCROSSJOIN"):
            self.next()
            self.expect_punct("(")
            args = [self.parse_set()]
            while self.peek() and self.peek().kind == "punct" and self.peek().value == ",":
                self.next()
                args.append(self.parse_set())
            self.expect_punct(")")
            return [("cross", args)]
        if t.kind == "punct" and t.value == "{":
            self.next()
            out = []
            if not (self.peek() and self.peek().kind == "punct" and self.peek().value == "}"):
                out += self.parse_set()
                while self.peek() and self.peek().kind == "punct" and self.peek().value == ",":
                    self.next()
                    out += self.parse_set()
            self.expect_punct("}")
            return out
        if t.kind == "punct" and t.value == "(":
            # Parenthesised set or TUPLE. A multi-member tuple keeps its
            # grouping: ([F], [1-URGENT]) is one combination of two
            # hierarchies, and flattening it loses exactly the meaning
            # Excel's per-tuple filters depend on.
            self.next()
            out = self.parse_set()
            while self.peek() and self.peek().kind == "punct" and self.peek().value == ",":
                self.next()
                out += self.parse_set()
            self.expect_punct(")")
            if len(out) > 1 and all(isinstance(e, MemberRef) for e in out):
                return [("tuple", out)]
            return out
        if t.kind == "name":
            return [self.parse_member()]
        raise MdxUnsupported(f"unsupported set construct at {t}")

    # -- the statement ----------------------------------------------------
    def parse(self) -> MdxQuery:
        q = MdxQuery()
        self.expect_word("SELECT")
        # axes (optional: "SELECT FROM cube" has none)
        while not (self.peek() and self.peek().kind == "word" and self.peek().value == "FROM"):
            self.accept_word("NON")
            self.accept_word("EMPTY")
            entries = self.parse_set()
            if self.accept_word("DIMENSION"):
                self.expect_word("PROPERTIES")
                while True:
                    t = self.peek()
                    if t and t.kind in ("word", "name"):
                        # property names may be words or bracketed refs
                        if t.kind == "name":
                            self.parse_member()
                        else:
                            self.next()
                        if self.peek() and self.peek().kind == "punct" and self.peek().value == ".":
                            self.next()
                            continue
                        if self.peek() and self.peek().kind == "punct" and self.peek().value == ",":
                            # comma could start the next axis; only continue
                            # if what follows is another property name word
                            nxt = self.peek(1)
                            if nxt and nxt.kind == "word" and nxt.value not in ("NON", "FROM"):
                                self.next()
                                continue
                        break
                    break
            self.expect_word("ON")
            t = self.next()
            if t.kind != "word":
                raise MdxUnsupported(f"expected axis name, got {t}")
            axis = {"COLUMNS": 0, "ROWS": 1, "PAGES": 2}.get(t.value)
            if axis is None:
                raise MdxUnsupported(f"unsupported axis {t.value}")
            while len(q.axes) <= axis:
                q.axes.append(None)
            q.axes[axis] = entries
            if self.peek() and self.peek().kind == "punct" and self.peek().value == ",":
                self.next()
        self.expect_word("FROM")
        t = self.peek()
        if t and t.kind == "punct" and t.value == "(":
            # subselect: FROM (SELECT (sets) ON COLUMNS FROM [cube] ...)
            self.next()
            sub = self.parse()
            self.expect_punct(")")
            q.cube = sub.cube
            for entries in sub.axes:
                if entries:
                    q.subselect_filters.append(entries)
            q.subselect_filters.extend(sub.subselect_filters)
        else:
            tok = self.next()
            if tok.kind not in ("name", "word"):
                raise MdxUnsupported(f"expected cube name, got {tok}")
            q.cube = tok.value
        if self.accept_word("WHERE"):
            self.expect_punct("(")
            q.slicer += self.parse_set()
            while self.peek() and self.peek().kind == "punct" and self.peek().value == ",":
                self.next()
                q.slicer += self.parse_set()
            self.expect_punct(")")
        if self.accept_word("CELL"):
            self.expect_word("PROPERTIES")
            while self.peek():
                t = self.next()
                if t.kind == "word":
                    q.cell_properties.append(t.value)
                elif t.kind == "punct" and t.value == ",":
                    continue
                else:
                    break
        return q


def parse_mdx(statement: str) -> MdxQuery:
    return _Parser(tokenize(statement)).parse()
