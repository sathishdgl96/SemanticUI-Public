r"""A composite model, seen by Excel as a cube.

Everything in the discovery surface reads a view dict and a describe and
knows nothing else, so a model is presented as a synthetic pair. These
tests hold that disguise to its contract:

* the cube lists, with the model's fields under readable names;
* an MDX statement against it compiles to the model's own stitched SQL,
  not to a single-view query;
* the naming round-trips -- what discovery published is what execution
  can map back, which is the one place a mistake would show up as Excel
  asking for a field the planner has never heard of.
"""

from xml.etree import ElementTree

import pytest

from app.composites.schema import parse_definition
from app.xmla import composite_source as source
from app.xmla.soap import envelope, parse_request
from tests.test_xmla_discover import discover_body, rows_of

SALES = {
    "dimensions": [
        {"table": "CUSTOMER", "name": "CUSTOMER_ID", "dataType": "TEXT"},
        {"table": "CUSTOMER", "name": "REGION", "dataType": "TEXT"},
    ],
    "metrics": [{"table": "ORDERS", "name": "REVENUE", "dataType": "NUMBER"}],
    "facts": [],
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMER"}],
    "relationships": [
        {
            "name": "r",
            "table": "ORDERS",
            "refTable": "CUSTOMER",
            "foreignKey": ["CUSTOMER_ID"],
            "refKey": ["CUSTOMER_ID"],
        }
    ],
    "hierarchies": [],
}

SUPPORT = {
    "dimensions": [
        {"table": "CLIENT", "name": "CLIENT_ID", "dataType": "TEXT"},
        {"table": "TICKETS", "name": "PRIORITY", "dataType": "TEXT"},
    ],
    "metrics": [{"table": "TICKETS", "name": "TICKET_COUNT", "dataType": "NUMBER"}],
    "facts": [],
    "tables": [{"name": "TICKETS"}, {"name": "CLIENT"}],
    "relationships": [
        {
            "name": "r2",
            "table": "TICKETS",
            "refTable": "CLIENT",
            "foreignKey": ["CLIENT_ID"],
            "refKey": ["CLIENT_ID"],
        }
    ],
    "hierarchies": [],
}


def definition(**over):
    doc = {
        "schemaVersion": 1,
        "name": "Customer 360",
        "members": [
            {"alias": "sales", "database": "D", "schema": "S", "view": "SALES_SV"},
            {"alias": "support", "database": "D", "schema": "S", "view": "SUPPORT_SV"},
        ],
        "sharedDimensions": [
            {
                "name": "Customer",
                "bindings": {
                    "sales": {"table": "CUSTOMER", "column": "CUSTOMER_ID"},
                    "support": {"table": "CLIENT", "column": "CLIENT_ID"},
                },
            }
        ],
        "derivedMetrics": [
            {
                "name": "Revenue per ticket",
                "expr": {
                    "op": "/",
                    "left": {"metric": "sales:ORDERS.REVENUE"},
                    "right": {"metric": "support:TICKETS.TICKET_COUNT"},
                },
            }
        ],
    }
    doc.update(over)
    return parse_definition(doc)


class FakeModelSession:
    """An XmlaSession whose only cube is one composite model."""

    def __init__(self, defn=None):
        self.definition = defn or definition()
        self.view = {
            "database": "Models",
            "schema": "Team",
            "name": "Customer 360",
            "comment": "",
            "composite_id": "m1",
        }
        self.detail = source.synthetic_detail(
            self.definition, {"sales": SALES, "support": SUPPORT}
        )
        self.conn = object()

    def list_views(self):
        return [self.view]

    def describe(self, database, schema, view):
        if database == "Models":
            return self.detail
        return {"SALES_SV": SALES, "SUPPORT_SV": SUPPORT}[view]

    def model_definition(self, database, schema, view):
        return self.definition

    def user_hierarchies(self, view):
        return []


def discover(request_type: str, restrictions: str = "") -> ElementTree.Element:
    from app.xmla import discover as discover_module

    request = parse_request(discover_body(request_type, restrictions))
    return ElementTree.fromstring(
        envelope(discover_module.handle(FakeModelSession(), request))
    )


# ------------------------------------------------------------ the disguise


class TestSyntheticDetail:
    def test_shared_dimensions_live_under_the_model_name(self):
        detail = source.synthetic_detail(
            definition(), {"sales": SALES, "support": SUPPORT}
        )
        assert {"table": "Customer 360", "name": "Customer", "dataType": "TEXT"} in (
            detail["dimensions"]
        )

    def test_a_members_own_field_keeps_its_table_in_the_name(self):
        detail = source.synthetic_detail(
            definition(), {"sales": SALES, "support": SUPPORT}
        )
        assert {
            "table": "sales",
            "name": "CUSTOMER.REGION",
            "dataType": "TEXT",
        } in detail["dimensions"]

    def test_a_column_already_shared_is_not_offered_twice(self):
        # CUSTOMER.CUSTOMER_ID is bound as "Customer". Offering it again
        # under `sales` would be two ways to group by one thing, giving
        # different answers depending which was dragged.
        detail = source.synthetic_detail(
            definition(), {"sales": SALES, "support": SUPPORT}
        )
        names = {(d["table"], d["name"]) for d in detail["dimensions"]}
        assert ("sales", "CUSTOMER.CUSTOMER_ID") not in names
        assert ("Customer 360", "Customer") in names

    def test_metrics_carry_their_member_and_the_derived_ones_the_model(self):
        detail = source.synthetic_detail(
            definition(), {"sales": SALES, "support": SUPPORT}
        )
        metrics = {(m["table"], m["name"]) for m in detail["metrics"]}
        assert ("sales", "ORDERS.REVENUE") in metrics
        assert ("support", "TICKETS.TICKET_COUNT") in metrics
        assert ("Customer 360", "Revenue per ticket") in metrics

    def test_a_member_that_cannot_be_described_is_skipped_not_fatal(self):
        # A model naming a view this caller may not read still exposes the
        # ones they may; Snowflake refuses the rest when asked.
        detail = source.synthetic_detail(definition(), {"sales": SALES})
        metrics = {m["name"] for m in detail["metrics"]}
        assert "ORDERS.REVENUE" in metrics
        assert "TICKETS.TICKET_COUNT" not in metrics

    def test_the_folder_cannot_collide_with_a_member_alias(self):
        # A shadowed folder would make `sales.X` ambiguous on the way back.
        defn = definition(
            name="sales",
            sharedDimensions=[
                {
                    "name": "Customer",
                    "bindings": {
                        "sales": {"table": "CUSTOMER", "column": "CUSTOMER_ID"},
                        "support": {"table": "CLIENT", "column": "CLIENT_ID"},
                    },
                }
            ],
        )
        assert source.folder_name(defn) != "sales"

    def test_a_dot_in_a_workspace_or_model_name_cannot_split_the_cube_name(self):
        class Row:
            id = "m1"
            name = "Q3.Revenue"

        view = source.synthetic_view(Row(), "Finance.EU")
        assert "." not in view["schema"]
        assert "." not in view["name"]


class TestNamingRoundTrip:
    @pytest.mark.parametrize(
        "published,expected",
        [
            ("sales.ORDERS.REVENUE", "sales:ORDERS.REVENUE"),
            ("support.TICKETS.PRIORITY", "support:TICKETS.PRIORITY"),
            ("Customer 360.Customer", "Customer"),
            ("Customer 360.Revenue per ticket", "Revenue per ticket"),
        ],
    )
    def test_what_discovery_published_maps_back_to_a_model_reference(
        self, published, expected
    ):
        assert source.to_model_ref(definition(), published) == expected

    def test_every_published_field_maps_to_something_the_planner_accepts(self):
        # The property that matters: Excel can only ask for what discovery
        # offered, so if all of that maps back, no drag can produce a
        # reference the planner has never heard of.
        from app.composites.planner import plan

        defn = definition()
        detail = source.synthetic_detail(defn, {"sales": SALES, "support": SUPPORT})
        dims = [
            source.to_model_ref(defn, f"{d['table']}.{d['name']}")
            for d in detail["dimensions"]
        ]
        metrics = [
            source.to_model_ref(defn, f"{m['table']}.{m['name']}")
            for m in detail["metrics"]
        ]
        for metric in metrics:
            # One at a time: a member-local dimension is only legal beside
            # its own view's metric, which is the planner's own rule.
            stitch = plan(defn, dimensions=["Customer"], metrics=[metric])
            assert stitch.branches
        assert "Customer" in dims


# ------------------------------------------------------------- discovery


class TestModelAsCube:
    def test_the_model_lists_as_a_cube(self):
        rows = rows_of(discover("MDSCHEMA_CUBES"))
        assert [r["CUBE_NAME"] for r in rows] == ["Models.Team.Customer 360"]

    def test_its_dimensions_are_the_model_and_its_members(self):
        rows = rows_of(discover("MDSCHEMA_DIMENSIONS"))
        names = {r["DIMENSION_NAME"] for r in rows}
        assert "Customer 360" in names
        assert "sales" in names

    def test_its_measures_include_the_derived_one(self):
        rows = rows_of(discover("MDSCHEMA_MEASURES"))
        names = {r["MEASURE_NAME"] for r in rows}
        assert "sales.ORDERS.REVENUE" in names
        assert "Customer 360.Revenue per ticket" in names

    def test_a_measure_unique_name_survives_the_mdx_tokenizer(self):
        # `[Measures].[sales.ORDERS.REVENUE]` -- the dots inside the
        # brackets must not be read as part separators, or Excel's own
        # request would parse into the wrong field.
        from app.xmla.mdx import tokenize

        rows = rows_of(discover("MDSCHEMA_MEASURES"))
        unique = next(
            r["MEASURE_UNIQUE_NAME"]
            for r in rows
            if r["MEASURE_NAME"] == "sales.ORDERS.REVENUE"
        )
        toks = tokenize(unique)
        assert [t.value for t in toks if t.kind == "name"] == [
            "Measures",
            "sales.ORDERS.REVENUE",
        ]


# -------------------------------------------------------------- execution


class TestExecute:
    def _sql(self, statement: str) -> str:
        from app.xmla.composite_engine import _CompositeEngine
        from app.xmla.mdx import parse_mdx

        session = FakeModelSession()
        q = parse_mdx(statement)
        engine = _CompositeEngine(
            session, session.view, session.detail, q, session.definition
        )
        sql, params, _ = engine._compile(
            ["Customer 360.Customer"], ["sales.ORDERS.REVENUE"], []
        )
        return sql

    def test_a_model_cube_compiles_to_the_stitched_statement(self):
        sql = self._sql(
            "SELECT {[Measures].[sales.ORDERS.REVENUE]} ON COLUMNS "
            "FROM [Models.Team.Customer 360]"
        )
        # One branch only: nothing asked support anything.
        assert "SEMANTIC_VIEW(" in sql
        assert '"D"."S"."SALES_SV"' in sql

    def test_asking_both_members_joins_them(self):
        from app.xmla.composite_engine import _CompositeEngine
        from app.xmla.mdx import parse_mdx

        session = FakeModelSession()
        q = parse_mdx(
            "SELECT {[Measures].[sales.ORDERS.REVENUE]} ON COLUMNS "
            "FROM [Models.Team.Customer 360]"
        )
        engine = _CompositeEngine(
            session, session.view, session.detail, q, session.definition
        )
        sql, _, _ = engine._compile(
            ["Customer 360.Customer"],
            ["sales.ORDERS.REVENUE", "support.TICKETS.TICKET_COUNT"],
            [],
        )
        assert sql.count("SEMANTIC_VIEW(") == 2
        assert "FULL OUTER JOIN" in sql

    def test_a_derived_measure_is_computed_over_the_join(self):
        from app.xmla.composite_engine import _CompositeEngine
        from app.xmla.mdx import parse_mdx

        session = FakeModelSession()
        q = parse_mdx("SELECT FROM [Models.Team.Customer 360]")
        engine = _CompositeEngine(
            session, session.view, session.detail, q, session.definition
        )
        sql, _, _ = engine._compile(
            ["Customer 360.Customer"], ["Customer 360.Revenue per ticket"], []
        )
        assert "CASE WHEN" in sql
        assert sql.count("SEMANTIC_VIEW(") == 2

    def test_a_filter_is_rewritten_into_the_models_namespace(self):
        import pydantic

        from app.reports.filters import FilterList
        from app.xmla.composite_engine import _CompositeEngine
        from app.xmla.mdx import parse_mdx

        class W(pydantic.BaseModel):
            filters: FilterList = []

        filters = W(
            filters=[
                {
                    "id": "f1",
                    "field": "sales.CUSTOMER.REGION",
                    "op": "is",
                    "values": ["EU"],
                }
            ]
        ).filters

        session = FakeModelSession()
        q = parse_mdx("SELECT FROM [Models.Team.Customer 360]")
        engine = _CompositeEngine(
            session, session.view, session.detail, q, session.definition
        )
        sql, params, _ = engine._compile(
            ["Customer 360.Customer"],
            ["sales.ORDERS.REVENUE", "support.TICKETS.TICKET_COUNT"],
            filters,
        )
        # The member's own column, and a gate narrowing the other branch.
        assert '"CUSTOMER"."REGION"' in sql
        assert "g_sales" in sql
        # Values still bind; none of them reaches the SQL text.
        assert "EU" not in sql
        assert "EU" in params


class TestRouting:
    """handle_execute must pick the composite engine for a model cube, and
    leave every other cube exactly where it was."""

    def test_an_mdx_statement_against_a_model_runs_the_stitched_sql(
        self, monkeypatch
    ):
        from app.snowflake.gateway import QueryResult
        from app.xmla import engine as engine_module
        from app.xmla import execute as execute_module

        seen: list[str] = []

        def fake_run_query(conn, sql, *, max_rows, params=None):
            seen.append(sql)
            return QueryResult(
                columns=["Customer", "sales:ORDERS.REVENUE"],
                rows=[["ACME", 10]],
                truncated=False,
                sfqid="q1",
            )

        monkeypatch.setattr(engine_module.gateway, "run_query", fake_run_query)
        monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)

        request = type(
            "R",
            (),
            {
                "statement": (
                    "SELECT {[Measures].[sales.ORDERS.REVENUE]} ON COLUMNS "
                    "FROM [Models.Team.Customer 360]"
                )
            },
        )()
        xml = execute_module.handle_execute(FakeModelSession(), request)

        assert "<root" in xml
        # It went through the model's own compiler, not a single-view query.
        assert seen and '"D"."S"."SALES_SV"' in seen[0]

    def test_an_unknown_cube_is_still_a_404(self):
        from app.errors import ApiError
        from app.xmla import execute as execute_module

        request = type("R", (), {"statement": "SELECT FROM [No.Such.Cube]"})()
        with pytest.raises(ApiError) as caught:
            execute_module.handle_execute(FakeModelSession(), request)
        assert caught.value.status == 404
