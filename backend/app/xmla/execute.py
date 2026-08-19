r"""Execute: the MDX Excel sends, answered from the semantic query builder.

The statement-less Execute is BeginSession's vehicle and answers with the
empty-namespace root. Real statements go through the mdx parser, become one
or more semantic queries on the CALLER'S OWN connection, and come back as
the mddataset shape Excel accepts (see dataset.py).

The engine supports what Excel's pivot engine emits, learned from the wire:
up to two axes, each carrying a measure set and/or ONE attribute-hierarchy
drill; WHERE tuples and subselects as filters. An axis with an All-member
drill answers the All tuple from a coarser aggregate query -- one query per
distinct grouping the axes require (at most four), all on one connection.
"""

from app.config import get_settings
from app.errors import ApiError
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import gateway
from app.xmla import dataset
from app.xmla.discover import path_unique_name, user_hierarchies
from app.xmla.mdx import HierSpec, MdxQuery, MdxUnsupported, MemberRef, parse_mdx

#: All-member DisplayInfo: DRILLED_DOWN flag plus the child count.
_DRILLED = 0x10000


def empty_dataset() -> str:
    """The canonical answer to a statement-less Execute.

    Real SSAS replies with the EMPTY-namespace root, not an empty mddataset;
    ADOMD.NET rejects the mddataset variant as "unrecognizable" (verified on
    the wire, 2026-08-18), so the distinction is load-bearing.
    """
    return (
        '<ExecuteResponse xmlns="urn:schemas-microsoft-com:xml-analysis">'
        "<return>"
        '<root xmlns="urn:schemas-microsoft-com:xml-analysis:empty"/>'
        "</return></ExecuteResponse>"
    )


# ------------------------------------------------------- axis interpretation

def _classify(entries, detail, exists_filters: list | None = None,
              user_hiers: dict | None = None) -> list[HierSpec]:
    """Axis entries from the parser -> [measures spec?] + [field specs].

    `exists_filters`, when given, collects equality filters contributed by
    Exists(setA, setB): B's members constrain the whole query, which is
    exactly what scopes a dropdown's child level to the expanded member.
    """
    measures: list[str] = []
    fields: dict[tuple[str, str], HierSpec] = {}

    def field_spec(table: str, name: str) -> HierSpec:
        key = (table.upper(), name.upper())
        if key not in fields:
            uh = (user_hiers or {}).get(key)
            if uh is not None:
                fields[key] = HierSpec(
                    kind="userhier", table=uh["home"], hier_field=uh["name"],
                    include_all=False, children_of_all=False,
                    levels=list(uh["levels"]),
                )
            else:
                fields[key] = HierSpec(
                    kind="drill", table=table, hier_field=name,
                    include_all=False, children_of_all=False,
                )
        return fields[key]

    def on_member(ref: MemberRef, drilled: bool) -> None:
        if ref.is_measure:
            if len(ref.parts) != 2:
                raise MdxUnsupported(f"measure ref {ref.parts}")
            measures.append(ref.parts[1])
            return
        if len(ref.parts) < 2:
            raise MdxUnsupported(f"member ref {ref.parts}")
        table, name = ref.parts[0], ref.parts[1]
        spec = field_spec(table, name)
        rest = ref.parts[2:]
        if spec.kind == "userhier":
            is_all = (len(rest) == 1 and not ref.keyed[2]
                      and rest[0].upper() in ("ALL", "(ALL)"))
            path = () if (not rest or is_all) else tuple(rest)
            if ref.suffix == "CHILDREN":
                spec.drilled_paths.add(path)
                if not path:
                    spec.include_all = True
                return
            if ref.suffix == "MEMBERS":
                if not rest:
                    spec.include_all = True
                    spec.drilled_paths.add(())
                elif is_all:
                    spec.include_all = True
                else:
                    # Level.Members: exactly that level's members, FLAT.
                    # Returning a drilled tree here is how the dropdown
                    # ended up showing one mixed level instead of each
                    # level on demand.
                    depth = next(
                        (i for i, (_, n) in enumerate(spec.levels, start=1)
                         if n.upper() == rest[0].upper()),
                        0,
                    )
                    if depth:
                        spec.flat_depths.add(depth)
                return
            if not path:
                spec.include_all = True
                if drilled:
                    spec.drilled_paths.add(())
                return
            spec.member_paths.append(path)
            if drilled:
                spec.drilled_paths.add(path)
            return
        if ref.suffix == "CHILDREN":
            # Only the All member has children in a two-level attribute
            # hierarchy. A LEAF's .Children is the empty set -- answering
            # the whole level again is how a filter dropdown ends up
            # showing the same top-level values on every expansion.
            if not rest or (len(rest) == 1 and rest[0].upper() == "ALL"):
                spec.children_of_all = True
            return
        if ref.suffix == "MEMBERS":
            # [T].[F].Members = All + leaves; [T].[F].[F].Members = the leaf
            # LEVEL's members; [T].[F].[(All)].Members = just the All member.
            if not rest:
                spec.include_all = True
                spec.children_of_all = True
            elif rest[0].upper() == name.upper():
                spec.children_of_all = True
            elif rest[0].upper() in ("(ALL)", "ALL"):
                spec.include_all = True
            else:
                raise MdxUnsupported(f"members of level {ref.parts}")
            return
        if not rest or (len(rest) == 1 and rest[0].upper() == "ALL"):
            spec.include_all = True
            if drilled:
                spec.children_of_all = True
            return
        if len(rest) == 1:
            spec.members.append(rest[0])
            return
        raise MdxUnsupported(f"deep member path {ref.parts}")

    def walk(entry, drilled=False):
        if isinstance(entry, MemberRef):
            on_member(entry, drilled)
        elif isinstance(entry, tuple) and entry[0] == "drill":
            on_member(entry[1], True)
        elif isinstance(entry, tuple) and entry[0] == "cross":
            for arg in entry[1]:
                for e in arg:
                    walk(e, drilled)
        elif isinstance(entry, tuple) and entry[0] == "drillmember":
            on_drillmember(entry[1], entry[2], entry[3])
        elif isinstance(entry, tuple) and entry[0] == "tuple":
            for e in entry[1]:
                walk(e, drilled)
        elif isinstance(entry, tuple) and entry[0] == "exists":
            for e in entry[1]:
                walk(e, drilled)
            by_field: dict[tuple[str, str], list[str]] = {}
            for e in entry[2]:
                if not (isinstance(e, MemberRef) and not e.is_measure
                        and len(e.parts) >= 3):
                    continue
                uh = (user_hiers or {}).get((e.parts[0].upper(), e.parts[1].upper()))
                if uh is not None:
                    for i, v in enumerate(e.parts[2:]):
                        if i >= len(uh["levels"]):
                            break
                        t, n = uh["levels"][i]
                        by_field.setdefault((t, n), []).append(v)
                    continue
                if len(e.parts) == 3:
                    by_field.setdefault((e.parts[0], e.parts[1]), []).append(e.parts[2])
            if exists_filters is not None:
                for (table, name), values in by_field.items():
                    exists_filters.append({
                        "id": f"exists{len(exists_filters)}",
                        "field": f"{table}.{name}",
                        "op": "is",
                        "values": values,
                    })
        else:
            raise MdxUnsupported(f"unsupported axis entry {entry!r}")

    def on_drillmember(base, drill, target) -> None:
        """DrilldownMember(base, drillSet, hierarchy): Excel's collapse.

        The base tuples walk in as usual; the target hierarchy gains its
        leaf members -- but only under the parents the drill set names.
        {-{m}} (the complement) means "expand everything except m", the
        shape Excel sends when one group row is collapsed.
        """
        for e in base:
            walk(e)
        # User-hierarchy drills need no target: a path expands into its OWN
        # next level. Handle them before the attribute early-return, or a
        # same-hierarchy drill (no third argument) is silently lost.
        for e in drill:
            if (isinstance(e, MemberRef) and not e.is_measure
                    and len(e.parts) >= 3
                    and (user_hiers or {}).get(
                        (e.parts[0].upper(), e.parts[1].upper())) is not None):
                field_spec(e.parts[0], e.parts[1]).drilled_paths.add(
                    tuple(e.parts[2:])
                )
            elif isinstance(e, tuple) and e[0] == "except":
                for inner in e[1]:
                    if (isinstance(inner, MemberRef) and not inner.is_measure
                            and len(inner.parts) >= 3
                            and (user_hiers or {}).get(
                                (inner.parts[0].upper(),
                                 inner.parts[1].upper())) is not None):
                        uspec = field_spec(inner.parts[0], inner.parts[1])
                        path = tuple(inner.parts[2:])
                        uspec.undrilled_paths.add(path)
                        uspec.drilled_depths.add(len(path))
        target_ref = next(
            (e for e in target
             if isinstance(e, MemberRef) and not e.is_measure and len(e.parts) == 2),
            None,
        )
        if target_ref is None:
            # No (usable) hierarchy argument: our attribute hierarchies have
            # no deeper level to drill into, so the drill is a no-op.
            return
        child = field_spec(target_ref.parts[0], target_ref.parts[1])
        child.children_of_all = True

        include: list[str] | None = None
        exclude: list[str] = []
        parent: tuple | None = None

        def leaf_values(entries):
            nonlocal parent
            out = []
            for e in entries:
                if not (isinstance(e, MemberRef) and not e.is_measure
                        and len(e.parts) >= 3):
                    continue
                key = (e.parts[0].upper(), e.parts[1].upper())
                if (user_hiers or {}).get(key) is not None:
                    # Drilling a user-hierarchy member: its PATH expands.
                    field_spec(e.parts[0], e.parts[1]).drilled_paths.add(
                        tuple(e.parts[2:])
                    )
                    continue
                if len(e.parts) == 3:
                    parent = key
                    out.append(e.parts[2])
                    walk(e)  # the named member also belongs to the base axis
            return out

        for e in drill:
            if isinstance(e, tuple) and e[0] == "except":
                for inner in e[1]:
                    if (isinstance(inner, MemberRef) and not inner.is_measure
                            and len(inner.parts) >= 3):
                        key = (inner.parts[0].upper(), inner.parts[1].upper())
                        if (user_hiers or {}).get(key) is not None:
                            uspec = field_spec(inner.parts[0], inner.parts[1])
                            path = tuple(inner.parts[2:])
                            uspec.undrilled_paths.add(path)
                            uspec.drilled_depths.add(len(path))
                            continue
                    exclude.extend(leaf_values([inner]))
            elif isinstance(e, MemberRef):
                include = (include or []) + leaf_values([e])
        if parent is not None:
            child.parent_key = parent
            child.parent_exclude = exclude
            child.parent_include = include

    for entry in entries:
        walk(entry)

    specs: list[HierSpec] = []
    if measures:
        specs.append(HierSpec(kind="measures", measures=measures))
    specs.extend(fields.values())
    return specs


def _valid_measures(detail: dict, names: list[str]) -> list[str]:
    known = {f"{m['table']}.{m['name']}".upper(): f"{m['table']}.{m['name']}"
             for m in detail.get("metrics", [])}
    out = []
    for n in names:
        if n.upper() not in known:
            raise ApiError("XMLA_MDX", 400, f"unknown measure {n!r}")
        out.append(known[n.upper()])
    return out


# ---------------------------------------------------------------- execution

class _Engine:
    def __init__(self, session, view: dict, detail: dict, q: MdxQuery):
        self.session = session
        self.view = view
        self.detail = detail
        self.q = q
        #: User hierarchies visible to this session, keyed (HOME, NAME).
        self.user_hiers = {
            (h["home"].upper(), h["name"].upper()): h
            for h in user_hierarchies(session, view)
        }
        #: Per-level stand-in specs, so hierarchy path members share the
        #: same grouping and cell machinery as plain attribute fields.
        self._surrogates: dict[tuple, HierSpec] = {}
        self._results: dict[frozenset, dict] = {}
        self.filters: list[dict] = []
        #: ([field, ...], [[value, ...], ...]) rows kept by per-tuple
        #: filters -- Excel's "uncheck this child under this parent only".
        self.include_combos: list = []
        self.slicer_members: list[dict] = []
        self.measures: list[str] = []

    # -- helpers ----------------------------------------------------------
    def _run(self, group_fields: list[HierSpec]) -> dict:
        """Aggregate metrics grouped by these fields; cached per grouping.
        Returns {tuple(dim values): [metric values...]}, insertion-ordered.
        """
        key = frozenset((s.table.upper(), s.hier_field.upper()) for s in group_fields)
        if key in self._results:
            return self._results[key]
        dims = [f"{s.table}.{s.hier_field}" for s in group_fields]
        request = SemanticQueryRequest.model_validate({
            "database": self.view["database"],
            "schema": self.view["schema"],
            "view": self.view["name"],
            "dimensions": dims,
            "metrics": self.measures,
            "filters": self.filters,
            "orderBy": [{"field": d, "direction": "asc"} for d in dims],
            "limit": None,
        })
        sql, params, limit = build_semantic_sql(
            self.detail, request, max_rows=get_settings().export_row_cap,
            include_combos=self.include_combos,
        )
        result = gateway.run_query(
            self.session.conn, sql, max_rows=limit, params=params
        )
        n = len(dims)
        table = {}
        for row in result.rows:
            table[tuple(row[:n])] = list(row[n:])
        self._results[key] = table
        return table

    def _surrogate(self, table: str, name: str) -> HierSpec:
        key = (table.upper(), name.upper())
        if key not in self._surrogates:
            self._surrogates[key] = HierSpec(
                kind="drill", table=table, hier_field=name,
                include_all=False, children_of_all=False,
            )
        return self._surrogates[key]

    # -- member builders --------------------------------------------------
    @staticmethod
    def _hier_uname(spec: HierSpec) -> str:
        return f"[{spec.table}].[{spec.hier_field}]"

    def _all_member(self, spec: HierSpec, child_count: int) -> dict:
        u = self._hier_uname(spec)
        return {
            "hierarchy": u,
            "uname": f"{u}.[All]",
            "caption": "All",
            "lname": f"{u}.[(All)]",
            "lnum": 0,
            "display_info": _DRILLED | min(child_count, 0xFFFF),
        }

    def _leaf_member(self, spec: HierSpec, value) -> dict:
        u = self._hier_uname(spec)
        caption = "" if value is None else str(value)
        return {
            "hierarchy": u,
            "uname": f"{u}.&[{caption}]",
            "caption": caption,
            "lname": f"{u}.[{spec.hier_field}]",
            "lnum": 1,
            "display_info": 0,
            "properties": {
                "PARENT_UNIQUE_NAME": f"{u}.[All]",
                "HIERARCHY_UNIQUE_NAME": u,
            },
        }

    def _userhier_members(self, spec: HierSpec) -> list:
        """(member, assignment) pairs for a user hierarchy on an axis, in
        Hierarchize order: each shown path, parents before children, with
        children under every drilled path. Values come from prefix-scoped
        DISTINCT group-bys, one per depth, cached like every grouping."""
        levels = spec.levels
        hu = self._hier_uname(spec)

        def drilled(path: tuple) -> bool:
            if path in spec.undrilled_paths:
                return False
            return path in spec.drilled_paths or len(path) in spec.drilled_depths

        def member(path: tuple) -> dict:
            depth = len(path)
            caption = "" if path[-1] is None else str(path[-1])
            info = 0
            if depth < len(levels):
                info = (_DRILLED if drilled(path) else 0) | 1000
            return {
                "hierarchy": hu,
                "uname": path_unique_name(spec.table, spec.hier_field, path),
                "caption": caption,
                "lname": f"{hu}.[{levels[depth - 1][1]}]",
                "lnum": depth,
                "display_info": info,
                "properties": {
                    "PARENT_UNIQUE_NAME": (
                        path_unique_name(spec.table, spec.hier_field, path[:-1])
                        if depth > 1 else f"{hu}.[All]"
                    ),
                    "HIERARCHY_UNIQUE_NAME": hu,
                },
            }

        def assignment(path: tuple) -> dict:
            return {
                (levels[i][0].upper(), levels[i][1].upper()): path[i]
                for i in range(len(path))
            }

        def children(prefix: tuple) -> list:
            depth = len(prefix) + 1
            if depth > len(levels):
                return []
            table = self._run([self._surrogate(t, n) for t, n in levels[:depth]])
            return [k for k in table if k[: len(prefix)] == prefix]

        out: list = []
        emitted: set = set()

        def emit(path: tuple) -> None:
            if path in emitted:
                return
            emitted.add(path)
            out.append((member(path), assignment(path)))

        def walk(prefix: tuple) -> None:
            for key in children(prefix):
                emit(key)
                if drilled(key):
                    walk(key)

        if spec.include_all:
            info = (_DRILLED if drilled(()) else 0) | 1000
            out.append((
                {
                    "hierarchy": hu,
                    "uname": f"{hu}.[All]",
                    "caption": "All",
                    "lname": f"{hu}.[(All)]",
                    "lnum": 0,
                    "display_info": info,
                },
                None,
            ))
        for depth in sorted(spec.flat_depths):
            if 1 <= depth <= len(levels):
                table = self._run(
                    [self._surrogate(t, n) for t, n in levels[:depth]]
                )
                for key in table:
                    emit(key)
        if drilled(()):
            walk(())
        for path in spec.member_paths:
            emit(path)
            if drilled(path):
                walk(path)
        # A drilled path whose own member is not shown (the dropdown asks
        # for [H].&[EUROPE].Children alone) still answers its children.
        for path in sorted(spec.drilled_paths, key=len):
            if path and path not in emitted:
                walk(path)
        return out

    def _measure_member(self, name: str) -> dict:
        return {
            "hierarchy": "[Measures]",
            "uname": f"[Measures].[{name}]",
            "caption": name.split(".", 1)[-1],
            "lname": "[Measures].[MeasuresLevel]",
            "lnum": 0,
            "display_info": 0,
        }

    # -- the run ----------------------------------------------------------
    def execute(self) -> str:
        q = self.q
        axis_specs = [
            _classify(entries, self.detail, exists_filters=self.filters,
                      user_hiers=self.user_hiers)
            if entries else []
            for entries in q.axes
        ]

        # WHERE and subselects: measures select cells, members filter rows.
        where_measures: list[str] = []
        for ref in q.slicer:
            if ref.is_measure:
                where_measures.append(ref.parts[1])
            else:
                self._member_filter(ref)
        for entries in q.subselect_filters:
            # Tuple entries keep their combination: they become one
            # (fields) IN ((values), ...) predicate, which is what makes
            # "1-URGENT unchecked under F but kept under O" reach Snowflake
            # as a fact rather than dissolving into two independent lists.
            combos: dict[tuple, list[list]] = {}
            plain = []
            for entry in entries:
                if isinstance(entry, tuple) and entry[0] == "tuple":
                    refs = [e for e in entry[1]
                            if isinstance(e, MemberRef) and not e.is_measure
                            and len(e.parts) == 3]
                    if len(refs) >= 2:
                        key = tuple(f"{r.parts[0]}.{r.parts[1]}" for r in refs)
                        combos.setdefault(key, []).append(
                            [r.parts[2] for r in refs]
                        )
                        continue
                    plain.extend(refs)
                    continue
                plain.append(entry)
            for key, rows in combos.items():
                self.include_combos.append((list(key), rows))
            for spec in _classify(plain, self.detail, user_hiers=self.user_hiers):
                if spec.kind == "measures":
                    continue
                if spec.members:
                    self.filters.append({
                        "id": f"mdx{len(self.filters)}",
                        "field": f"{spec.table}.{spec.hier_field}",
                        "op": "is",
                        "values": spec.members,
                    })

        axis_measures = [m for specs in axis_specs
                         for s in specs if s.kind == "measures"
                         for m in s.measures]
        # No measure anywhere means a member-list query: run it dimension-
        # only and answer no cells. Inventing a default measure breaks the
        # moment it cannot legally group by the queried field.
        self.measures = _valid_measures(
            self.detail, axis_measures or where_measures
        )

        # Build each axis's tuple list plus a resolver from tuple index to
        # (leaf-field assignment, measure index). An axis may carry several
        # hierarchies (Excel's CrossJoin of drilldowns): its tuples are the
        # cross product of each hierarchy's member list, first hierarchy
        # outermost, exactly CrossJoin's enumeration order. Combinations of
        # leaf members that the data never produces are pruned, which is
        # what NON EMPTY means for the shapes Excel sends.
        from itertools import product

        axes_out = []       # (name, hierarchy names, tuples)
        resolvers = []      # per axis: list of (assignments dict, measure)
        for index, specs in enumerate(axis_specs):
            name = f"Axis{index}"
            field_specs = [s for s in specs if s.kind != "measures"]
            has_measures = any(s.kind == "measures" for s in specs)
            measure_list = list(range(len(self.measures))) if has_measures else [None]

            per_spec = []   # per hierarchy: [(member dict, assignment|None)]
            for spec in field_specs:
                if spec.kind == "userhier":
                    per_spec.append(self._userhier_members(spec))
                    continue
                values = list(self._run([spec]).keys())
                members = []
                if spec.include_all:
                    members.append((self._all_member(spec, len(values)), None))
                if spec.children_of_all:
                    for (value,) in values:
                        members.append(
                            (self._leaf_member(spec, value), {spec_key(spec): value})
                        )
                elif spec.members:
                    have = {str(v[0]).upper(): v[0] for v in values}
                    for m in spec.members:
                        value = have.get(m.upper(), m)
                        members.append(
                            (self._leaf_member(spec, value), {spec_key(spec): value})
                        )
                per_spec.append(members)

            # DisplayInfo is how the server TELLS Excel each member's
            # drill state (0x10000 = drilled down); Excel rebuilds its own
            # bookkeeping from it after every response. Without the flag a
            # collapse is forgotten by the very next gesture (observed
            # live: collapsing O silently re-expanded F).
            for j, spec in enumerate(field_specs[:-1]):
                child = field_specs[j + 1]
                for member, assignment in per_spec[j]:
                    if assignment is None:
                        continue
                    value = assignment.get(spec_key(spec))
                    expanded = _parent_drilled(child, spec, value)
                    member["display_info"] = (
                        (_DRILLED if expanded else 0) | 1000
                    )

            tuples, resolver, hier_names = [], [], []
            field_spec_by_key = {spec_key(s): s for s in field_specs}
            for spec in field_specs:
                if spec.kind == "userhier":
                    for t, n in spec.levels:
                        field_spec_by_key[(t.upper(), n.upper())] = self._surrogate(t, n)
            for combo in (product(*per_spec) if per_spec else [()]):
                assignment: dict = {}
                for _, a in combo:
                    if a:
                        assignment.update(a)
                if not _drill_allowed(field_specs, assignment):
                    continue
                # NON EMPTY: a combination of leaf members that never occurs
                # together in the data contributes no tuple at all.
                if len(assignment) > 1:
                    group = [field_spec_by_key[k] for k in assignment]
                    if tuple(assignment[spec_key(s)] for s in group) not in self._run(group):
                        continue
                for mi in measure_list:
                    tup = [m for m, _ in combo]
                    if mi is not None:
                        tup.append(self._measure_member(self.measures[mi]))
                    if not tup:
                        continue
                    tuples.append(tup)
                    resolver.append((assignment, mi))
            if not tuples:
                continue
            for spec in field_specs:
                hier_names.append((
                    self._hier_uname(spec),
                    ["PARENT_UNIQUE_NAME", "HIERARCHY_UNIQUE_NAME"],
                ))
            # (user hierarchies share the same shape: unique name + the
            # two declared member properties)
            if has_measures:
                hier_names.append(("[Measures]", []))
            axes_out.append((name, hier_names, tuples))
            resolvers.append(resolver)

        # Slicer: WHERE members, else the effective measure if there is one.
        slicer_tuple = list(self.slicer_members)
        if not axis_measures and self.measures:
            slicer_tuple.append(self._measure_member(self.measures[0]))
        slicer_hiers = [(m["hierarchy"], []) for m in slicer_tuple]
        # An empty slicer is an empty <Tuples/>, never an empty <Tuple/> --
        # the mddataset schema requires a Member in every Tuple, and both
        # ADOMD and Excel refuse the whole response over it (verified by
        # validating our own wire capture against the embedded XSD).
        axes_out.append(
            ("SlicerAxis", slicer_hiers, [slicer_tuple] if slicer_tuple else [])
        )

        # Cells: iterate the cartesian product of axis tuples, row-major
        # with Axis0 fastest -- CellOrdinal = i1 * len(axis0) + i0.
        cells = []
        if not self.measures:
            pass  # member-list query: tuples only, no cells
        elif not resolvers:
            table = self._run([])
            value = next(iter(table.values()), [None, None])[0]
            if value is not None:
                cells.append((0, value))
        else:
            shape = [len(r) for r in resolvers]
            total = 1
            for n in shape:
                total *= n
            field_spec_map = {}
            for specs in axis_specs:
                for s in specs:
                    if s.kind == "userhier":
                        for t, n in s.levels:
                            field_spec_map[(t.upper(), n.upper())] = self._surrogate(t, n)
                    elif s.kind != "measures":
                        field_spec_map[spec_key(s)] = s
            for ordinal in range(total):
                rem, coords = ordinal, []
                for n in shape:
                    coords.append(rem % n)
                    rem //= n
                assignment: dict = {}
                measure_index = 0
                for axis_i, coord in enumerate(coords):
                    a, mi = resolvers[axis_i][coord]
                    if a:
                        assignment.update(a)
                    if mi is not None:
                        measure_index = mi
                group = [field_spec_map[k] for k in assignment]
                table = self._run(group)
                key = tuple(assignment[spec_key(s)] for s in group)
                row = table.get(key)
                if row is None:
                    continue
                value = row[measure_index]
                if value is None:
                    continue
                cells.append((ordinal, value))

        cube = self.q.cube
        return dataset.mddataset(cube, axes_out, cells)

    def _member_filter(self, ref: MemberRef) -> None:
        if len(ref.parts) < 3:
            return  # a bare hierarchy in WHERE means its All member: no-op
        table, name, value = ref.parts[0], ref.parts[1], ref.parts[2]
        uh = self.user_hiers.get((table.upper(), name.upper()))
        if uh is not None:
            path = tuple(ref.parts[2:])
            if len(path) == 1 and not ref.keyed[2] and path[0].upper() in ("ALL", "(ALL)"):
                return
            for i, v in enumerate(path):
                if i >= len(uh["levels"]):
                    break
                t, n = uh["levels"][i]
                self.filters.append({
                    "id": f"mdx{len(self.filters)}",
                    "field": f"{t}.{n}",
                    "op": "is",
                    "values": [v],
                })
            hu = f"[{uh['home']}].[{uh['name']}]"
            self.slicer_members.append({
                "hierarchy": hu,
                "uname": path_unique_name(uh["home"], uh["name"], path),
                "caption": str(path[-1]),
                "lname": f"{hu}.[{uh['levels'][min(len(path), len(uh['levels'])) - 1][1]}]",
                "lnum": len(path),
                "display_info": 0,
            })
            return
        if value.upper() == "ALL":
            return
        self.filters.append({
            "id": f"mdx{len(self.filters)}",
            "field": f"{table}.{name}",
            "op": "is",
            "values": [value],
        })
        u = f"[{table}].[{name}]"
        self.slicer_members.append({
            "hierarchy": u,
            "uname": f"{u}.&[{value}]",
            "caption": value,
            "lname": f"{u}.[{name}]",
            "lnum": 1,
            "display_info": 0,
        })


def spec_key(spec: HierSpec) -> tuple[str, str]:
    return (spec.table.upper(), spec.hier_field.upper())


def _parent_drilled(child: HierSpec, parent: HierSpec, value) -> bool:
    """Whether this parent member's children are shown, per the drill
    constraints DrilldownMember put on the child hierarchy."""
    if child.parent_key is None or child.parent_key != spec_key(parent):
        return True
    v = "" if value is None else str(value).upper()
    if child.parent_include is not None and v not in {
        m.upper() for m in child.parent_include
    }:
        return False
    return v not in {m.upper() for m in child.parent_exclude}


def _drill_allowed(field_specs, assignment: dict) -> bool:
    """False for a tuple whose leaf members sit under a collapsed parent.

    A constrained hierarchy's leaves appear only where the DrilldownMember
    drill set said they should. The parent at its All member always keeps
    its children -- those are the cross-hierarchy subtotal rows the client
    has always been sent and tolerates.
    """
    for spec in field_specs:
        if spec.parent_key is None or spec_key(spec) not in assignment:
            continue
        parent_value = assignment.get(spec.parent_key)
        if parent_value is None:
            continue
        value = str(parent_value).upper()
        if spec.parent_include is not None and value not in {
            m.upper() for m in spec.parent_include
        }:
            return False
        if value in {m.upper() for m in spec.parent_exclude}:
            return False
    return True


def handle_execute(session, request) -> str:
    statement = (request.statement or "").strip()
    if not statement:
        return empty_dataset()
    try:
        q = parse_mdx(statement)
    except MdxUnsupported as exc:
        raise ApiError("XMLA_MDX", 400, f"unsupported MDX: {exc}") from exc

    view = None
    for v in session.list_views():
        from app.xmla.discover import cube_name

        if cube_name(v).upper() == q.cube.upper():
            view = v
            break
    if view is None:
        raise ApiError("XMLA_MDX", 404, f"unknown cube {q.cube!r}")
    detail = session.describe(view["database"], view["schema"], view["name"])
    try:
        return _Engine(session, view, detail, q).execute()
    except MdxUnsupported as exc:
        raise ApiError("XMLA_MDX", 400, f"unsupported MDX: {exc}") from exc
