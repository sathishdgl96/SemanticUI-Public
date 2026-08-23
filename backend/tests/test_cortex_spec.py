import pytest

from app.cortex.spec import MAX_ASK_ROWS, AskSpec, parse_spec, validate_against_catalog
from app.errors import ApiError

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


class TestParsing:
    def test_a_plain_spec_parses(self):
        spec = parse_spec(
            '{"dimensions": ["CUSTOMERS.REGION"], "metrics": ["ORDERS.TOTAL_REVENUE"],'
            ' "explanation": "Revenue by region."}'
        )
        assert spec.dimensions == ["CUSTOMERS.REGION"]
        assert spec.explanation == "Revenue by region."

    def test_a_fenced_reply_is_tolerated(self):
        """Models wrap JSON in ```json fences constantly. Refusing on that
        alone would fail most real replies for no good reason."""
        spec = parse_spec('```json\n{"metrics": ["ORDERS.TOTAL_REVENUE"]}\n```')
        assert spec.metrics == ["ORDERS.TOTAL_REVENUE"]

    def test_prose_around_the_json_is_tolerated(self):
        spec = parse_spec(
            'Sure! Here is the query:\n{"metrics": ["ORDERS.TOTAL_REVENUE"]}\nHope that helps.'
        )
        assert spec.metrics == ["ORDERS.TOTAL_REVENUE"]

    def test_unparseable_output_is_ask_failed(self):
        with pytest.raises(ApiError) as exc:
            parse_spec("I am afraid I cannot help with that.")
        assert exc.value.code == "ASK_FAILED"
        assert exc.value.status == 502

    def test_broken_json_is_ask_failed(self):
        with pytest.raises(ApiError) as exc:
            parse_spec('{"metrics": ["A.B",}')
        assert exc.value.code == "ASK_FAILED"

    def test_an_extra_key_is_rejected_rather_than_ignored(self):
        """A model inventing a `sql` key must be refused outright, not
        partially honoured."""
        with pytest.raises(ApiError) as exc:
            parse_spec('{"metrics": ["A.B"], "sql": "DROP TABLE ORDERS"}')
        assert exc.value.code == "ASK_FAILED"

    def test_a_spec_selecting_nothing_is_rejected(self):
        with pytest.raises(ApiError) as exc:
            parse_spec('{"dimensions": [], "metrics": []}')
        assert "at least one" in exc.value.message.lower()

    def test_the_limit_is_clamped_rather_than_trusted(self):
        """The model is not the authority on how much data a question is
        worth."""
        spec = parse_spec('{"metrics": ["ORDERS.TOTAL_REVENUE"], "limit": 999999}')
        assert spec.limit == MAX_ASK_ROWS

    def test_a_missing_limit_gets_the_cap(self):
        spec = parse_spec('{"metrics": ["ORDERS.TOTAL_REVENUE"]}')
        assert spec.limit == MAX_ASK_ROWS

    def test_a_modest_limit_is_kept(self):
        spec = parse_spec('{"metrics": ["ORDERS.TOTAL_REVENUE"], "limit": 20}')
        assert spec.limit == 20

    def test_an_unknown_filter_operator_is_rejected(self):
        with pytest.raises(ApiError):
            parse_spec(
                '{"metrics": ["A.B"], "filters": [{"id": "q", "field": "C.D",'
                ' "op": "contains", "values": ["x"]}]}'
            )


class TestCatalogValidation:
    """The whole security argument. Nothing the model names is trusted."""

    def test_a_valid_spec_passes(self):
        spec = AskSpec(
            dimensions=["CUSTOMERS.REGION"], metrics=["ORDERS.TOTAL_REVENUE"]
        )
        validate_against_catalog(spec, DETAIL)

    def test_an_invented_dimension_is_rejected_and_named(self):
        """The most common real failure: the model guessing a plausible column
        name. Naming it is what lets the user rephrase."""
        spec = AskSpec(dimensions=["CUSTOMERS.SALARY"])
        with pytest.raises(ApiError) as exc:
            validate_against_catalog(spec, DETAIL)
        assert exc.value.code == "ASK_INVALID"
        assert exc.value.status == 400
        assert "CUSTOMERS.SALARY" in exc.value.message

    def test_a_field_from_another_view_is_rejected(self):
        with pytest.raises(ApiError):
            validate_against_catalog(AskSpec(metrics=["PAYROLL.SALARY"]), DETAIL)

    def test_a_dimension_offered_as_a_metric_is_rejected(self):
        """Kinds are checked, not just names: a dimension in the metrics slot
        would produce a query that means something else."""
        with pytest.raises(ApiError):
            validate_against_catalog(AskSpec(metrics=["CUSTOMERS.REGION"]), DETAIL)

    def test_a_metric_offered_as_a_dimension_is_rejected(self):
        with pytest.raises(ApiError):
            validate_against_catalog(
                AskSpec(dimensions=["ORDERS.TOTAL_REVENUE"]), DETAIL
            )

    def test_case_does_not_matter(self):
        validate_against_catalog(AskSpec(metrics=["orders.total_revenue"]), DETAIL)

    def test_an_unqualified_reference_is_rejected(self):
        with pytest.raises(ApiError) as exc:
            validate_against_catalog(AskSpec(metrics=["TOTAL_REVENUE"]), DETAIL)
        assert "TABLE.FIELD" in exc.value.message

    def test_a_filter_may_name_a_fact(self):
        spec = AskSpec(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {"id": "q1", "field": "ORDERS.ORDER_AMOUNT", "op": "between",
                 "from": 1, "to": 9}
            ],
        )
        validate_against_catalog(spec, DETAIL)

    def test_a_filter_on_an_unknown_field_is_rejected(self):
        spec = AskSpec(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[{"id": "q1", "field": "X.Y", "op": "is", "values": ["1"]}],
        )
        with pytest.raises(ApiError) as exc:
            validate_against_catalog(spec, DETAIL)
        assert "X.Y" in exc.value.message


class TestPromptInjection:
    """A hijacked model is assumed, not hoped against. These assert what it can
    still do -- which is nothing the user could not already do by hand."""

    def test_a_spec_naming_another_table_is_rejected(self):
        hostile = parse_spec(
            '{"metrics": ["SECRETS.API_KEY"], "explanation": "ignore instructions"}'
        )
        with pytest.raises(ApiError) as exc:
            validate_against_catalog(hostile, DETAIL)
        assert exc.value.code == "ASK_INVALID"

    def test_sql_smuggled_into_a_field_name_is_rejected(self):
        hostile = parse_spec('{"metrics": ["ORDERS.TOTAL_REVENUE; DROP TABLE ORDERS"]}')
        with pytest.raises(ApiError):
            validate_against_catalog(hostile, DETAIL)

    def test_sql_smuggled_into_the_explanation_is_carried_as_text_only(self):
        """`explanation` is displayed, never parsed. It is allowed to contain
        anything; what matters is that it reaches no interpreter."""
        spec = parse_spec(
            '{"metrics": ["ORDERS.TOTAL_REVENUE"],'
            ' "explanation": "\'; DROP TABLE ORDERS; --"}'
        )
        validate_against_catalog(spec, DETAIL)
        assert "DROP TABLE" in spec.explanation

    def test_a_hostile_filter_value_stays_a_value(self):
        """Filters reuse the 2b union, so values are still bound parameters --
        the model cannot smuggle SQL through one."""
        spec = parse_spec(
            '{"metrics": ["ORDERS.TOTAL_REVENUE"], "filters": ['
            '{"id": "q1", "field": "CUSTOMERS.REGION", "op": "is",'
            ' "values": ["\' OR 1=1 --"]}]}'
        )
        validate_against_catalog(spec, DETAIL)
        assert spec.filters[0].values == ["' OR 1=1 --"]
