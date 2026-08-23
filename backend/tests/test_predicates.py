from datetime import date

import pytest
from pydantic import TypeAdapter

from app.errors import ApiError
from app.reports.filters import Filter
from app.semantic.predicates import (
    PLACEHOLDER,
    build_filter_predicates,
    resolve_relative_date,
)

ADAPTER = TypeAdapter(list[Filter])

DETAIL = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMERS"}],
    "relationships": [],
    "dimensions": [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "VARCHAR(16777216)"},
    ],
    "metrics": [{"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER(38,2)"}],
    "facts": [{"table": "ORDERS", "name": "ORDER_AMOUNT", "dataType": "NUMBER(38,2)"}],
}


def build(payload: list[dict], **kwargs):
    return build_filter_predicates(DETAIL, ADAPTER.validate_python(payload), **kwargs)


def test_no_filters_produces_nothing():
    assert build([]) == ([], [])


def test_is_with_one_value_emits_equals():
    sql, params = build(
        [{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}]
    )
    assert sql == [f'"CUSTOMERS"."REGION" = {PLACEHOLDER}']
    assert params == ["EAST"]


def test_is_with_many_values_emits_in():
    sql, params = build(
        [
            {
                "id": "f1",
                "field": "CUSTOMERS.REGION",
                "op": "is",
                "values": ["EAST", "WEST", "NORTH"],
            }
        ]
    )
    assert sql == [
        f'"CUSTOMERS"."REGION" IN ({PLACEHOLDER}, {PLACEHOLDER}, {PLACEHOLDER})'
    ]
    assert params == ["EAST", "WEST", "NORTH"]


def test_is_not_negates():
    sql, params = build(
        [
            {
                "id": "f1",
                "field": "CUSTOMERS.REGION",
                "op": "isNot",
                "values": ["EAST", "WEST"],
            }
        ]
    )
    assert sql == [f'"CUSTOMERS"."REGION" NOT IN ({PLACEHOLDER}, {PLACEHOLDER})']
    assert params == ["EAST", "WEST"]


def test_is_not_with_one_value_emits_not_equals():
    sql, _ = build(
        [{"id": "f1", "field": "CUSTOMERS.REGION", "op": "isNot", "values": ["EAST"]}]
    )
    assert sql == [f'"CUSTOMERS"."REGION" <> {PLACEHOLDER}']


def test_between_emits_two_placeholders():
    sql, params = build(
        [
            {
                "id": "f1",
                "field": "ORDERS.ORDER_AMOUNT",
                "op": "between",
                "from": 10,
                "to": 20,
            }
        ]
    )
    assert sql == [f'"ORDERS"."ORDER_AMOUNT" BETWEEN {PLACEHOLDER} AND {PLACEHOLDER}']
    assert params == [10, 20]


def test_parameters_are_ordered_across_several_filters():
    """The cursor binds positionally, so a wrong order is a wrong answer rather
    than an error -- worth pinning explicitly."""
    sql, params = build(
        [
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST", "WEST"]},
            {"id": "f2", "field": "ORDERS.ORDER_AMOUNT", "op": "between", "from": 1, "to": 9},
        ]
    )
    assert len(sql) == 2
    assert params == ["EAST", "WEST", 1, 9]


def test_relative_date_resolves_server_side_to_two_bound_dates():
    sql, params = build(
        [
            {
                "id": "f1",
                "field": "ORDERS.ORDER_DATE",
                "op": "relativeDate",
                "unit": "day",
                "count": 30,
            }
        ],
        today=date(2026, 8, 15),
    )
    assert sql == [f'"ORDERS"."ORDER_DATE" BETWEEN {PLACEHOLDER} AND {PLACEHOLDER}']
    assert params == [date(2026, 7, 17), date(2026, 8, 15)]


def test_a_filter_may_reference_a_fact():
    sql, _ = build(
        [{"id": "f1", "field": "ORDERS.ORDER_AMOUNT", "op": "between", "from": 1, "to": 2}]
    )
    assert sql[0].startswith('"ORDERS"."ORDER_AMOUNT"')


def test_filtering_on_a_metric_is_rejected():
    """An aggregate needs HAVING, not WHERE. Rejecting beats silently building
    a query that means something else."""
    with pytest.raises(ApiError) as exc:
        build(
            [
                {
                    "id": "f1",
                    "field": "ORDERS.TOTAL_REVENUE",
                    "op": "between",
                    "from": 1,
                    "to": 2,
                }
            ]
        )
    assert exc.value.code == "QUERY_ERROR"
    assert "aggregate" in exc.value.message.lower()


def test_an_unknown_field_is_rejected():
    with pytest.raises(ApiError) as exc:
        build([{"id": "f1", "field": "CUSTOMERS.NOPE", "op": "is", "values": ["X"]}])
    assert "CUSTOMERS.NOPE" in exc.value.message


def test_an_unqualified_field_is_rejected():
    with pytest.raises(ApiError):
        build([{"id": "f1", "field": "REGION", "op": "is", "values": ["X"]}])


def test_the_field_name_comes_from_the_catalog_not_the_request():
    """Case is normalised to what DESCRIBE reported, so the emitted identifier
    can never be attacker-shaped even when the reference matches."""
    sql, _ = build([{"id": "f1", "field": "customers.region", "op": "is", "values": ["X"]}])
    assert sql == [f'"CUSTOMERS"."REGION" = {PLACEHOLDER}']


class TestInjectionRoundTrip:
    """The central security property: a value containing SQL metacharacters
    must survive as data and appear nowhere in the generated SQL text."""

    HOSTILE = [
        "' OR 1=1 --",
        "'; DROP TABLE ORDERS; --",
        '" OR ""="',
        "\\'; SELECT 1; --",
        "EAST') OR ('1'='1",
    ]

    def test_hostile_values_never_reach_the_sql_string(self):
        sql, params = build(
            [{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": self.HOSTILE}]
        )
        joined = " ".join(sql)
        for value in self.HOSTILE:
            assert value not in joined, f"{value!r} leaked into SQL text"
        assert params == self.HOSTILE
        # Nothing but placeholders and the quoted identifier survive.
        assert joined.count(PLACEHOLDER) == len(self.HOSTILE)
        assert "'" not in joined
        assert "--" not in joined
        assert ";" not in joined

    def test_a_hostile_between_endpoint_is_bound_too(self):
        sql, params = build(
            [
                {
                    "id": "f1",
                    "field": "ORDERS.ORDER_DATE",
                    "op": "between",
                    "from": "2026-01-01' OR '1'='1",
                    "to": "2026-12-31",
                }
            ]
        )
        # Not `"OR" not in sql[0]` -- that substring also occurs inside
        # "ORDERS". The property under test is that the VALUE is absent.
        assert "2026-01-01' OR '1'='1" not in sql[0]
        assert "'" not in sql[0]
        assert sql[0] == f'"ORDERS"."ORDER_DATE" BETWEEN {PLACEHOLDER} AND {PLACEHOLDER}'
        assert params[0] == "2026-01-01' OR '1'='1"


class TestRelativeDateResolution:
    """Resolution runs against a passed-in clock, so these assert exact dates
    rather than 'about a month ago'."""

    TODAY = date(2026, 8, 15)

    def resolve(self, **payload):
        f = TypeAdapter(Filter).validate_python(
            {"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate", **payload}
        )
        return resolve_relative_date(f, self.TODAY)

    def test_last_1_day_is_today_only(self):
        assert self.resolve(unit="day", count=1) == (date(2026, 8, 15), date(2026, 8, 15))

    def test_last_7_days_is_a_seven_day_window_ending_today(self):
        assert self.resolve(unit="day", count=7) == (date(2026, 8, 9), date(2026, 8, 15))

    def test_last_3_months_starts_at_the_first_of_the_third_month_back(self):
        assert self.resolve(unit="month", count=3) == (date(2026, 6, 1), date(2026, 8, 15))

    def test_a_month_window_crossing_a_year_boundary(self):
        f = TypeAdapter(Filter).validate_python(
            {
                "id": "f1",
                "field": "ORDERS.ORDER_DATE",
                "op": "relativeDate",
                "unit": "month",
                "count": 3,
            }
        )
        assert resolve_relative_date(f, date(2026, 1, 20)) == (
            date(2025, 11, 1),
            date(2026, 1, 20),
        )

    def test_last_2_years_starts_at_january_of_the_prior_year(self):
        assert self.resolve(unit="year", count=2) == (date(2025, 1, 1), date(2026, 8, 15))

    def test_month_to_date(self):
        assert self.resolve(preset="monthToDate") == (date(2026, 8, 1), date(2026, 8, 15))

    def test_year_to_date(self):
        assert self.resolve(preset="yearToDate") == (date(2026, 1, 1), date(2026, 8, 15))


class TestInactiveFilters:
    """A filter the user has started but not finished means "not filtering
    yet", not "match nothing".

    This is not cosmetic. Adding a filter and not yet ticking a value used to
    422 every tile on the report, because `IN ()` is neither valid SQL nor a
    valid request body. Found by driving the real API in a browser; every
    stubbed test missed it.
    """

    def test_an_is_filter_with_no_values_is_accepted_and_ignored(self):
        assert build([
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": []}
        ]) == ([], [])

    def test_an_is_not_filter_with_no_values_is_ignored(self):
        assert build([
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "isNot", "values": []}
        ]) == ([], [])

    def test_a_between_with_empty_endpoints_is_ignored(self):
        """Switching the operator to `between` seeds empty strings; they are
        not a range until the user types one."""
        assert build([
            {"id": "f1", "field": "ORDERS.ORDER_AMOUNT", "op": "between",
             "from": "", "to": ""}
        ]) == ([], [])

    def test_a_half_filled_between_is_ignored(self):
        assert build([
            {"id": "f1", "field": "ORDERS.ORDER_AMOUNT", "op": "between",
             "from": "5", "to": ""}
        ]) == ([], [])

    def test_a_between_of_zero_to_zero_is_still_a_real_filter(self):
        """0 is falsy but is a perfectly good bound -- the emptiness check must
        not swallow it."""
        sql, params = build([
            {"id": "f1", "field": "ORDERS.ORDER_AMOUNT", "op": "between",
             "from": 0, "to": 0}
        ])
        assert len(sql) == 1
        assert params == [0, 0]

    def test_an_inactive_filter_does_not_shift_the_parameter_order(self):
        """The dangerous failure: dropping a fragment but keeping its params
        would bind every later value to the wrong placeholder."""
        sql, params = build([
            {"id": "f0", "field": "CUSTOMERS.REGION", "op": "is", "values": []},
            {"id": "f1", "field": "ORDERS.ORDER_AMOUNT", "op": "between",
             "from": 1, "to": 9},
        ])
        assert len(sql) == 1
        assert params == [1, 9]

    def test_an_inactive_filter_on_an_unknown_field_is_still_rejected(self):
        """Being inactive is not a way to smuggle an unvalidated reference
        into a saved report."""
        with pytest.raises(ApiError):
            build([{"id": "f1", "field": "CUSTOMERS.NOPE", "op": "is", "values": []}])
