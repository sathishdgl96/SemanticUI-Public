"""The composite model definition document.

What a composite says: which semantic views are its **members**, which
columns across them mean the **same thing** (conformed dimensions), and
what arithmetic to do on the results (derived metrics).

Three rules shape everything here.

**Joins are declared, never inferred.** A conformed dimension exists
because a person who understands both models said these two columns are
the same thing. Nothing guesses from column names -- a `CUSTOMER_ID` in
two views is not evidence, it is a coincidence waiting to produce wrong
numbers quietly.

**Aliases namespace everything.** A member is referenced by its alias, so
`sales:REVENUE` and `support:REVENUE` are different metrics and neither
is ambiguous. Display names may collide freely; references may not.

**Expressions are an AST, never a string.** A derived metric is a small
closed tree of operators, metric references and numbers. The same
discipline filters follow: nothing a user types becomes SQL text.

This module validates the document's shape and its internal consistency.
It does NOT check bindings against the member views -- that needs a
Snowflake connection, and a draft must remain saveable when the
warehouse is asleep. That check is its own step, run against the
describe cache before a composite is queried.
"""

import json
from typing import Literal, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import ApiError, safe_error_details

SCHEMA_VERSION = 1

#: Past eight members nobody is reading the field list, and every member
#: is a branch in the compiled query. A cap that refuses with a sentence
#: beats a model that merely gets slower.
MAX_MEMBERS = 8
MAX_SHARED_DIMENSIONS = 12
MAX_DERIVED_METRICS = 24
MAX_DEFINITION_BYTES = 65536
#: Snowflake identifiers cap at 255.
MAX_IDENT = 255
#: An alias is typed constantly in field references, so it stays short.
MAX_ALIAS = 32
#: Deep enough for a ratio of two sums of differences; shallow enough
#: that a hostile document cannot make the validator recurse forever.
MAX_EXPR_DEPTH = 8


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Member(_Strict):
    """One semantic view taking part, under a name the model uses for it."""

    #: How every field reference names this member. Letters, digits and
    #: underscores only: it is a namespace prefix, not a label.
    alias: str = Field(min_length=1, max_length=MAX_ALIAS, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")
    database: str = Field(min_length=1, max_length=MAX_IDENT)
    schema_: str = Field(min_length=1, max_length=MAX_IDENT, alias="schema")
    view: str = Field(min_length=1, max_length=MAX_IDENT)


class Binding(_Strict):
    """Where one member holds a conformed dimension."""

    table: str = Field(min_length=1, max_length=MAX_IDENT)
    column: str = Field(min_length=1, max_length=MAX_IDENT)


class SharedDimension(_Strict):
    """One business concept, and where each member keeps it.

    N-ary on purpose. Five members must not need ten pairwise mappings --
    they need one row saying "this is Customer, and here is Customer in
    each of you".
    """

    name: str = Field(min_length=1, max_length=200)
    #: alias -> the key column that JOINS. At least two, because a
    #: "shared" dimension present in one member is just a local field.
    bindings: dict[str, Binding] = Field(min_length=2)
    #: alias -> the column that DISPLAYS. Optional: keys join, labels
    #: read. A model whose keys are meaningful needs no labels at all.
    labels: dict[str, Binding] = Field(default_factory=dict)


class MetricRef(_Strict):
    """`alias:METRIC` -- one member's metric, named unambiguously."""

    metric: str = Field(min_length=3, max_length=MAX_IDENT + MAX_ALIAS + 1)


class Literal_(_Strict):
    value: float


#: Forward reference: an operand is a number, a metric, or another
#: operation.
Operand = Union["BinaryOp", MetricRef, Literal_]


class BinaryOp(_Strict):
    op: Literal["+", "-", "*", "/"]
    left: Operand
    right: Operand


BinaryOp.model_rebuild()


class DerivedMetric(_Strict):
    """Arithmetic over member metrics, evaluated AFTER each has aggregated.

    The only honest place for a cross-view ratio: revenue and tickets are
    each summed by their own view at the shared grain, and only then
    divided. Dividing row by row would be a different number and a wrong
    one.
    """

    name: str = Field(min_length=1, max_length=200)
    expr: Operand
    #: Division by zero is NULL, not an error and not infinity -- "no
    #: tickets" makes revenue-per-ticket undefined, and a chart draws a
    #: gap for it. Default on, because the alternative is a query that
    #: fails for one bad row.
    nullIfDenominatorZero: bool = True


class CompositeDefinition(_Strict):
    schemaVersion: int = SCHEMA_VERSION
    name: str = Field(max_length=200)
    members: list[Member] = Field(default_factory=list, max_length=MAX_MEMBERS)
    sharedDimensions: list[SharedDimension] = Field(
        default_factory=list, max_length=MAX_SHARED_DIMENSIONS
    )
    derivedMetrics: list[DerivedMetric] = Field(
        default_factory=list, max_length=MAX_DERIVED_METRICS
    )
    #: How member results meet. `full` keeps a customer with tickets and
    #: no orders; `inner` keeps only those present everywhere. A MODEL
    #: decision, not a per-query one -- the same question must not answer
    #: two ways depending on who asks it.
    joinType: Literal["full", "inner"] = "full"
    #: What a filter on one member's own field does to the others.
    #: `semi`: the others are narrowed to the keys that survived it --
    #: "tickets for the customers this filter left", which is what people
    #: mean. `local`: the filter touches its own member only.
    #: Power BI made this choice silently and users found it as wrong
    #: numbers, so it is named here and shown in the UI.
    crossFilter: Literal["semi", "local"] = "semi"


def _invalid(message: str, details: str | None = None) -> ApiError:
    return ApiError("COMPOSITE_INVALID", 400, message, details)


def _expr_depth(node: Operand, depth: int = 1) -> int:
    if isinstance(node, BinaryOp):
        return max(
            _expr_depth(node.left, depth + 1), _expr_depth(node.right, depth + 1)
        )
    return depth


def _metric_refs(node: Operand) -> list[str]:
    if isinstance(node, BinaryOp):
        return _metric_refs(node.left) + _metric_refs(node.right)
    if isinstance(node, MetricRef):
        return [node.metric]
    return []


def split_ref(ref: str) -> tuple[str, str]:
    """`sales:ORDERS.REVENUE` -> ("sales", "ORDERS.REVENUE").

    Raises rather than returning a sentinel: an unqualified reference is
    not a thing this model can resolve, and guessing which member was
    meant is exactly how a composite starts reporting somebody else's
    numbers.
    """
    alias, sep, rest = ref.partition(":")
    if not sep or not alias or not rest:
        raise _invalid(
            f"Field reference {ref!r} does not name a member. "
            "Write it as alias:FIELD, for example sales:ORDERS.REVENUE."
        )
    return alias, rest


def parse_definition(raw: dict) -> CompositeDefinition:
    """Validate a document, or raise the error the client should see.

    Size is checked first and on the RAW document: a payload large enough
    to be a problem is a problem before it is parsed, not after.
    """
    encoded = json.dumps(raw, separators=(",", ":"), default=str)
    if len(encoded.encode("utf-8")) > MAX_DEFINITION_BYTES:
        raise ApiError(
            "COMPOSITE_TOO_LARGE", 413, "This composite model is too large to save."
        )
    try:
        definition = CompositeDefinition.model_validate(raw)
    except ValidationError as error:
        # `.errors()`, not the exception: serialising the exception would
        # echo the submitted document straight back in the response.
        raise _invalid(
            "This composite model is not valid.",
            str(safe_error_details(error.errors())),
        ) from error

    aliases = [member.alias for member in definition.members]
    seen: set[str] = set()
    for alias in aliases:
        # Case-insensitively, because two members called `sales` and
        # `Sales` would make every field reference a coin toss.
        key = alias.lower()
        if key in seen:
            raise _invalid(f"Two members share the alias {alias!r}.")
        seen.add(key)

    known = {alias.lower() for alias in aliases}

    # Two members naming the SAME view is not a composite, it is the same
    # view twice -- and every shared dimension over it would join a table
    # to itself.
    views: set[tuple[str, str, str]] = set()
    for member in definition.members:
        key3 = (member.database.upper(), member.schema_.upper(), member.view.upper())
        if key3 in views:
            raise _invalid(
                f"{member.database}.{member.schema_}.{member.view} is named twice. "
                "A composite joins different views."
            )
        views.add(key3)

    for shared in definition.sharedDimensions:
        for alias in list(shared.bindings) + list(shared.labels):
            if alias.lower() not in known:
                raise _invalid(
                    f"Shared dimension {shared.name!r} binds {alias!r}, "
                    "which is not a member of this model."
                )
        for alias in shared.labels:
            if alias.lower() not in {a.lower() for a in shared.bindings}:
                raise _invalid(
                    f"Shared dimension {shared.name!r} has a label for {alias!r} "
                    "but no key binding for it. A label without a key cannot join."
                )

    dimension_names = [shared.name.strip().lower() for shared in definition.sharedDimensions]
    if len(dimension_names) != len(set(dimension_names)):
        raise _invalid("Two shared dimensions share a name.")

    metric_names = [metric.name.strip().lower() for metric in definition.derivedMetrics]
    if len(metric_names) != len(set(metric_names)):
        raise _invalid("Two derived metrics share a name.")

    for metric in definition.derivedMetrics:
        if _expr_depth(metric.expr) > MAX_EXPR_DEPTH:
            raise _invalid(
                f"Derived metric {metric.name!r} nests too deeply "
                f"(limit {MAX_EXPR_DEPTH})."
            )
        refs = _metric_refs(metric.expr)
        if not refs:
            raise _invalid(
                f"Derived metric {metric.name!r} references no member metric. "
                "A constant is not a measurement."
            )
        for ref in refs:
            alias, _ = split_ref(ref)
            if alias.lower() not in known:
                raise _invalid(
                    f"Derived metric {metric.name!r} references {alias!r}, "
                    "which is not a member of this model."
                )

    # The rule that makes a composite answerable rather than merely
    # saveable. Checked last so the more specific errors above win.
    if len(definition.members) >= 2 and not definition.sharedDimensions:
        raise _invalid(
            "A model with more than one view needs at least one shared "
            "dimension -- the column that means the same thing in each. "
            "Without one there is no way to line their answers up."
        )
    return definition


def blank(name: str) -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "name": name,
        "members": [],
        "sharedDimensions": [],
        "derivedMetrics": [],
        "joinType": "full",
        "crossFilter": "semi",
    }
