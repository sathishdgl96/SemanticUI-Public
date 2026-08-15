import pytest
from pydantic import TypeAdapter, ValidationError

from app.reports.filters import (
    MAX_FILTER_VALUES,
    MAX_VALUE_LENGTH,
    BetweenFilter,
    Filter,
    InFilter,
    RelativeDateFilter,
)

ADAPTER = TypeAdapter(Filter)


def test_is_filter_parses():
    f = ADAPTER.validate_python(
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST", "WEST"]}
    )
    assert isinstance(f, InFilter)
    assert f.values == ["EAST", "WEST"]


def test_is_not_filter_parses():
    f = ADAPTER.validate_python(
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "isNot", "values": ["EAST"]}
    )
    assert isinstance(f, InFilter) and f.op == "isNot"


def test_unknown_operator_is_rejected():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "matches", "values": ["E%"]}
        )


def test_empty_value_list_is_rejected():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": []}
        )


def test_too_many_values_is_rejected():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {
                "id": "f1",
                "field": "CUSTOMERS.REGION",
                "op": "is",
                "values": [str(i) for i in range(MAX_FILTER_VALUES + 1)],
            }
        )


def test_an_overlong_value_is_rejected():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {
                "id": "f1",
                "field": "CUSTOMERS.REGION",
                "op": "is",
                "values": ["x" * (MAX_VALUE_LENGTH + 1)],
            }
        )


def test_between_parses_and_keeps_the_from_alias():
    f = ADAPTER.validate_python(
        {"id": "f1", "field": "ORDERS.TOTAL", "op": "between", "from": 10, "to": 20}
    )
    assert isinstance(f, BetweenFilter)
    assert (f.from_, f.to) == (10, 20)
    assert f.model_dump(by_alias=True)["from"] == 10


def test_between_rejects_reversed_endpoints():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "ORDERS.TOTAL", "op": "between", "from": 20, "to": 10}
        )


def test_between_rejects_mixed_endpoint_kinds():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {
                "id": "f1",
                "field": "ORDERS.TOTAL",
                "op": "between",
                "from": 10,
                "to": "2026-01-01",
            }
        )


def test_relative_date_accepts_unit_and_count():
    f = ADAPTER.validate_python(
        {
            "id": "f1",
            "field": "ORDERS.ORDER_DATE",
            "op": "relativeDate",
            "unit": "day",
            "count": 30,
        }
    )
    assert isinstance(f, RelativeDateFilter) and f.count == 30


def test_relative_date_accepts_a_preset():
    f = ADAPTER.validate_python(
        {
            "id": "f1",
            "field": "ORDERS.ORDER_DATE",
            "op": "relativeDate",
            "preset": "monthToDate",
        }
    )
    assert f.preset == "monthToDate"


def test_relative_date_rejects_both_forms_at_once():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {
                "id": "f1",
                "field": "ORDERS.ORDER_DATE",
                "op": "relativeDate",
                "unit": "day",
                "count": 30,
                "preset": "monthToDate",
            }
        )


def test_relative_date_rejects_neither_form():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate"}
        )


def test_relative_date_rejects_a_unit_without_a_count():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate", "unit": "day"}
        )


def test_extra_keys_are_forbidden():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {
                "id": "f1",
                "field": "CUSTOMERS.REGION",
                "op": "is",
                "values": ["EAST"],
                "sql": "1=1",
            }
        )
