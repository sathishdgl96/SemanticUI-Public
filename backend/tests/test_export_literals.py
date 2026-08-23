from datetime import date

import pytest

from app.errors import ApiError
from app.export.literals import build_literal_sql
from app.semantic.query import SemanticQueryRequest, build_semantic_sql

DETAIL = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMERS"}],
    "relationships": [],
    "dimensions": [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "VARCHAR(16777216)"},
    ],
    "metrics": [{"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER"}],
    "facts": [{"table": "ORDERS", "name": "ORDER_AMOUNT", "dataType": "NUMBER"}],
}


def req(**payload):
    base = {"database": "D", "schema": "S", "view": "V"}
    return SemanticQueryRequest.model_validate({**base, **payload})


def region_is(*values):
    return {"id": "f", "field": "CUSTOMERS.REGION", "op": "is", "values": list(values)}


def test_an_unfiltered_query_carries_no_placeholders():
    sql = build_literal_sql(DETAIL, req(metrics=["ORDERS.TOTAL_REVENUE"]))
    assert "?" not in sql
    assert "SEMANTIC_VIEW" in sql


def test_a_filter_value_is_inlined_as_a_quoted_literal():
    sql = build_literal_sql(
        DETAIL, req(metrics=["ORDERS.TOTAL_REVENUE"], filters=[region_is("EAST")])
    )
    assert "'EAST'" in sql
    assert "?" not in sql
    assert "WHERE" in sql


def test_several_values_become_an_in_list():
    sql = build_literal_sql(
        DETAIL,
        req(metrics=["ORDERS.TOTAL_REVENUE"], filters=[region_is("EAST", "WEST")]),
    )
    assert "IN ('EAST', 'WEST')" in sql


def test_a_quote_in_a_value_is_doubled_so_the_statement_stays_valid():
    """The escaping exists so a value containing a quote produces VALID SQL --
    not to prevent an escalation. The user runs this as themselves."""
    sql = build_literal_sql(
        DETAIL, req(metrics=["ORDERS.TOTAL_REVENUE"], filters=[region_is("O'Brien")])
    )
    assert "'O''Brien'" in sql


def test_a_hostile_value_cannot_terminate_the_statement():
    sql = build_literal_sql(
        DETAIL,
        req(metrics=["ORDERS.TOTAL_REVENUE"], filters=[region_is("' OR 1=1 --")]),
    )
    # One literal, not a closed string plus a clause.
    assert "''' OR 1=1 --'" in sql
    assert ";" not in sql


def test_a_number_is_not_quoted():
    sql = build_literal_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {
                    "id": "f",
                    "field": "ORDERS.ORDER_AMOUNT",
                    "op": "between",
                    "from": 1,
                    "to": 9,
                }
            ],
        ),
    )
    assert "BETWEEN 1 AND 9" in sql, sql


def test_a_relative_date_is_resolved_to_concrete_dates():
    """Power Query cannot evaluate "last 7 days"; it has to arrive resolved."""
    sql = build_literal_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {
                    "id": "f",
                    "field": "ORDERS.ORDER_DATE",
                    "op": "relativeDate",
                    "unit": "day",
                    "count": 7,
                }
            ],
        ),
        today=date(2026, 8, 16),
    )
    assert "TO_DATE('2026-08-10')" in sql
    assert "TO_DATE('2026-08-16')" in sql


def test_an_unfinished_filter_is_omitted_but_its_field_still_validated():
    """Being half-typed is not a way to slip an unvalidated reference into a
    statement handed to a user."""
    sql = build_literal_sql(
        DETAIL, req(metrics=["ORDERS.TOTAL_REVENUE"], filters=[region_is()])
    )
    assert "WHERE" not in sql

    with pytest.raises(ApiError):
        build_literal_sql(
            DETAIL,
            req(
                metrics=["ORDERS.TOTAL_REVENUE"],
                filters=[{"id": "f", "field": "X.NOPE", "op": "is", "values": []}],
            ),
        )


def test_an_unknown_field_is_still_rejected():
    """The copyable path validates identifiers exactly like the executable one."""
    with pytest.raises(ApiError):
        build_literal_sql(
            DETAIL,
            req(
                metrics=["ORDERS.TOTAL_REVENUE"],
                filters=[{"id": "f", "field": "X.Y", "op": "is", "values": ["1"]}],
            ),
        )


def test_the_where_clause_sits_inside_the_semantic_view_call():
    """Same rule as the executable path: the predicate applies before
    aggregation, or a metric-only query would be filtered on nothing."""
    sql = build_literal_sql(
        DETAIL, req(metrics=["ORDERS.TOTAL_REVENUE"], filters=[region_is("EAST")])
    )
    assert sql.index("WHERE") < sql.index("\n)")


def test_the_executable_builder_still_uses_placeholders():
    """The guard against these two paths being confused by a later refactor.

    If someone ever "simplifies" build_semantic_sql to inline its values, this
    fails -- and it should, loudly.
    """
    sql, params, _ = build_semantic_sql(
        DETAIL,
        req(metrics=["ORDERS.TOTAL_REVENUE"], filters=[region_is("EAST")]),
        max_rows=100,
    )
    assert "?" in sql
    assert "EAST" not in sql
    assert params == ["EAST"]


def test_the_literals_module_imports_nothing_that_can_execute():
    """Structural, not behavioural. The module's whole safety argument is that
    it cannot run what it builds, so that stays asserted rather than assumed.

    Parsed rather than grepped: the docstring names `gateway` precisely to say
    it is NOT used, and a substring scan would fail on its own explanation.
    """
    import ast

    import app.export.literals as literals

    tree = ast.parse(open(literals.__file__, encoding="utf-8").read())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
            imported.update(a.name for a in node.names)

    for forbidden in ("gateway", "run_query", "get_cache", "provider"):
        assert not any(forbidden in name for name in imported), (
            f"literals.py imports {forbidden}; it must not be able to execute"
        )
