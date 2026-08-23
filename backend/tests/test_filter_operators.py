"""The operator set beyond is/isNot/between/relativeDate.

Every test here asserts the same invariant from a different angle: the VALUE
is bound, never written into the statement.
"""

import pytest

from app.reports.filters import Filter, is_active
from app.semantic.predicates import build_filter_predicates
from pydantic import TypeAdapter

ADAPTER = TypeAdapter(Filter)

DETAIL = {
    "dimensions": [
        {"table": "CUSTOMERS", "name": "NAME"},
        {"table": "CUSTOMERS", "name": "REGION"},
    ],
    "facts": [{"table": "ORDERS", "name": "TOTAL"}],
    "metrics": [{"table": "ORDERS", "name": "REVENUE"}],
}


def f(**payload) -> Filter:
    return ADAPTER.validate_python({"id": "f1", **payload})


def build(*filters):
    return build_filter_predicates(DETAIL, list(filters))


# --- text ------------------------------------------------------------------


@pytest.mark.parametrize(
    "op,function",
    [
        ("contains", "CONTAINS"),
        ("startsWith", "STARTSWITH"),
        ("endsWith", "ENDSWITH"),
        ("notContains", "CONTAINS"),
    ],
)
def test_text_operators_call_a_literal_substring_function(op, function):
    sql, params = build(f(field="CUSTOMERS.NAME", op=op, value="ACME"))
    assert len(sql) == 1
    assert f"{function}(" in sql[0]
    assert "?" in sql[0]
    assert params == ["ACME"]
    # The value itself never reaches the statement.
    assert "ACME" not in sql[0]


def test_not_contains_negates():
    sql, _ = build(f(field="CUSTOMERS.NAME", op="notContains", value="X"))
    assert sql[0].startswith("NOT CONTAINS(")


def test_no_text_operator_uses_like():
    """Two reasons, one found against a real account: LIKE ... ESCAPE is a
    syntax error inside SEMANTIC_VIEW(), and a LIKE without ESCAPE would read
    a user's "%" as a wildcard -- silently returning more rows than they
    asked for."""
    for op in ("contains", "notContains", "startsWith", "endsWith"):
        sql, _ = build(f(field="CUSTOMERS.NAME", op=op, value="x"))
        assert "LIKE" not in sql[0]
        assert "ESCAPE" not in sql[0]


def test_a_users_wildcards_need_no_escaping_and_get_none():
    """The substring functions have no wildcard semantics at all, so "50%_x"
    is bound with its punctuation intact and matches those characters.

    Only the case is normalised (see below); nothing is escaped, because
    there is nothing here that escaping would protect against."""
    _, params = build(f(field="CUSTOMERS.NAME", op="contains", value="50%_x"))
    assert params == ["50%_X"]


@pytest.mark.parametrize(
    "op", ["contains", "notContains", "startsWith", "endsWith"]
)
def test_text_matching_ignores_case(op):
    """`CONTAINS(segment, 'mach')` finds nothing in a column of 'MACHINERY',
    and someone typing a search term is asking what it looks like they are
    asking. Both sides are upper-cased: the column in SQL, the value here."""
    sql, params = build(f(field="CUSTOMERS.NAME", op=op, value="acme corp"))
    assert "UPPER(" in sql[0]
    assert params == ["ACME CORP"]


def test_an_empty_pattern_is_not_yet_a_filter():
    assert is_active(f(field="CUSTOMERS.NAME", op="contains", value="")) is False
    sql, params = build(f(field="CUSTOMERS.NAME", op="contains", value=""))
    assert sql == [] and params == []


# --- comparison ------------------------------------------------------------


@pytest.mark.parametrize(
    "op,symbol", [("gt", ">"), ("gte", ">="), ("lt", "<"), ("lte", "<=")]
)
def test_comparison_operators_bind_their_value(op, symbol):
    sql, params = build(f(field="ORDERS.TOTAL", op=op, value=100))
    assert sql[0].endswith(f"{symbol} ?")
    assert params == [100]


def test_zero_is_a_real_bound():
    # A truthiness check here would drop the filter entirely.
    assert is_active(f(field="ORDERS.TOTAL", op="gt", value=0)) is True
    _, params = build(f(field="ORDERS.TOTAL", op="gt", value=0))
    assert params == [0]


def test_an_empty_comparison_is_not_yet_a_filter():
    assert is_active(f(field="ORDERS.TOTAL", op="gt", value="")) is False


# --- blank -----------------------------------------------------------------


def test_is_blank_covers_null_and_empty_string():
    """To the person reading the report those are the same absence."""
    sql, params = build(f(field="CUSTOMERS.REGION", op="isBlank"))
    assert "IS NULL" in sql[0] and "= ''" in sql[0]
    # A presence test binds nothing, so a stray param would misalign every
    # later placeholder.
    assert params == []


def test_is_not_blank_is_the_exact_complement():
    sql, _ = build(f(field="CUSTOMERS.REGION", op="isNotBlank"))
    assert "IS NOT NULL" in sql[0] and "<> ''" in sql[0]


def test_a_blank_filter_refuses_a_value():
    # An operator that ignored a value would let a stale one linger in the
    # saved document and mislead the next reader.
    with pytest.raises(Exception):
        ADAPTER.validate_python(
            {"id": "f1", "field": "C.R", "op": "isBlank", "value": "x"}
        )


# --- notBetween ------------------------------------------------------------


def test_not_between_negates_and_still_binds_both_ends():
    sql, params = build(f(field="ORDERS.TOTAL", op="notBetween", **{"from": 1, "to": 9}))
    assert "NOT BETWEEN ? AND ?" in sql[0]
    assert params == [1, 9]


def test_not_between_keeps_the_ordering_rule():
    with pytest.raises(Exception):
        ADAPTER.validate_python(
            {"id": "f1", "field": "O.T", "op": "notBetween", "from": 9, "to": 1}
        )


# --- shared invariants -----------------------------------------------------


def test_new_operators_still_reject_a_metric():
    for payload in (
        {"op": "contains", "value": "x"},
        {"op": "gt", "value": 1},
        {"op": "isBlank"},
    ):
        with pytest.raises(Exception) as exc:
            build(f(field="ORDERS.REVENUE", **payload))
        assert "metric" in str(exc.value.message).lower()


def test_new_operators_still_reject_an_unknown_field():
    with pytest.raises(Exception):
        build(f(field="CUSTOMERS.GHOST", op="contains", value="x"))


def test_mixed_operators_bind_in_fragment_order():
    """Binding is positional: a wrong order is a wrong answer, not an error."""
    sql, params = build(
        f(id="a", field="CUSTOMERS.NAME", op="contains", value="ACME"),
        f(id="b", field="CUSTOMERS.REGION", op="isBlank"),
        f(id="c", field="ORDERS.TOTAL", op="gte", value=5),
        f(id="d", field="CUSTOMERS.REGION", op="is", values=["EAST", "WEST"]),
    )
    assert len(sql) == 4
    # isBlank contributes no parameter, so the ones after it must not shift.
    assert params == ["ACME", 5, "EAST", "WEST"]


def test_an_unknown_operator_is_refused_by_the_union():
    with pytest.raises(Exception):
        ADAPTER.validate_python({"id": "f1", "field": "C.R", "op": "regex", "value": ".*"})
