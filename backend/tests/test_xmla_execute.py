r"""MDX execution, driven by the statements Excel actually sent.

Both fixtures below are verbatim wire captures (2026-08-18). The engine's
answers are checked for the mddataset landmarks Excel navigates by: axis
tuples with unique names, level names, DisplayInfo, and cell ordinals that
follow the Axis0-fastest convention.
"""

from xml.etree import ElementTree

import pytest

from app.snowflake.gateway import QueryResult
from app.xmla import execute as execute_module
from app.xmla.execute import handle_execute
from app.xmla.mdx import parse_mdx

SCALAR = (
    "SELECT FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS] "
    "WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE]) "
    "CELL PROPERTIES VALUE, FORMAT_STRING, LANGUAGE, BACK_COLOR, "
    "FORE_COLOR, FONT_FLAGS"
)

DRILL = (
    "SELECT NON EMPTY Hierarchize(AddCalculatedMembers({DrilldownLevel("
    "{[ORDERS].[ORDER_STATUS].[All]})})) DIMENSION PROPERTIES "
    "PARENT_UNIQUE_NAME,HIERARCHY_UNIQUE_NAME ON COLUMNS "
    "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS] "
    "CELL PROPERTIES VALUE, FORMAT_STRING, LANGUAGE, BACK_COLOR, "
    "FORE_COLOR, FONT_FLAGS"
)


class TestParse:
    def test_the_scalar_capture(self):
        q = parse_mdx(SCALAR)
        assert q.cube == "SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS"
        assert q.axes == []
        assert [r.parts for r in q.slicer] == [["Measures", "ORDERS.TOTAL_ORDER_VALUE"]]
        assert "VALUE" in q.cell_properties

    def test_the_drilldown_capture(self):
        q = parse_mdx(DRILL)
        assert len(q.axes) == 1
        assert q.slicer == []

    def test_measures_on_columns_field_on_rows(self):
        q = parse_mdx(
            "SELECT {[Measures].[ORDERS.ORDER_COUNT],[Measures].[ORDERS.TOTAL_ORDER_VALUE]} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS , "
            "NON EMPTY Hierarchize(AddCalculatedMembers({DrilldownLevel("
            "{[CUSTOMERS].[MARKET_SEGMENT].[All]})})) "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON ROWS "
            "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS]"
        )
        assert len(q.axes) == 2

    def test_subselect_filters(self):
        q = parse_mdx(
            "SELECT {[Measures].[ORDERS.ORDER_COUNT]} ON COLUMNS "
            "FROM (SELECT ({[ORDERS].[ORDER_STATUS].&[F],"
            "[ORDERS].[ORDER_STATUS].&[O]}) ON COLUMNS "
            "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS])"
        )
        assert q.cube == "SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS"
        assert len(q.subselect_filters) == 1


class FakeSession:
    """list_views + describe + a conn marker; queries are stubbed at the
    gateway, so the conn never has to behave like one."""

    conn = object()

    def list_views(self):
        return [{"database": "SEMANTIC_DEMO", "schema": "TPCH",
                 "name": "TPCH_SALES_ANALYTICS", "comment": None}]

    def describe(self, database, schema, view):
        return {
            "dimensions": [
                {"table": "ORDERS", "name": "ORDER_STATUS", "dataType": "TEXT"},
            ],
            "metrics": [
                {"table": "ORDERS", "name": "TOTAL_ORDER_VALUE", "dataType": "NUMBER"},
                {"table": "ORDERS", "name": "ORDER_COUNT", "dataType": "NUMBER"},
            ],
            "facts": [],
            "tables": [{"name": "ORDERS"}],
            "relationships": [],
        }


class FakeRequest:
    def __init__(self, statement):
        self.statement = statement


@pytest.fixture
def scripted_gateway(monkeypatch):
    def fake_run_query(conn, sql, *, max_rows, params=None):
        if "GROUP BY" in sql.upper() or "ORDER_STATUS" in sql.upper():
            return QueryResult(
                columns=[{"name": "ORDER_STATUS"}, {"name": "TOTAL_ORDER_VALUE"}],
                rows=[["F", 100.5], ["O", 200.25], ["P", None]],
                truncated=False,
                sfqid=None,
            )
        return QueryResult(
            columns=[{"name": "TOTAL_ORDER_VALUE"}],
            rows=[[300.75]],
            truncated=False,
            sfqid=None,
        )

    monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)


NS = {"m": "urn:schemas-microsoft-com:xml-analysis:mddataset",
      "x": "urn:schemas-microsoft-com:xml-analysis"}


class TestExecute:
    def test_scalar_answers_one_cell_and_a_measures_slicer(self, scripted_gateway):
        xml = handle_execute(FakeSession(), FakeRequest(SCALAR))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        axes = root.findall(".//m:Axes/m:Axis", NS)
        assert [a.get("name") for a in axes] == ["SlicerAxis"]
        member = axes[0].find(".//m:Member", NS)
        assert member.find("m:UName", NS).text == "[Measures].[ORDERS.TOTAL_ORDER_VALUE]"
        cells = root.findall(".//m:CellData/m:Cell", NS)
        assert len(cells) == 1
        assert cells[0].get("CellOrdinal") == "0"
        assert cells[0].find("m:Value", NS).text == "300.75"

    def test_drilldown_answers_all_plus_children_in_order(self, scripted_gateway):
        xml = handle_execute(FakeSession(), FakeRequest(DRILL))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        axis0 = root.find(".//m:Axes/m:Axis[@name='Axis0']", NS)
        unames = [m.find("m:UName", NS).text
                  for m in axis0.findall(".//m:Member", NS)]
        assert unames == [
            "[ORDERS].[ORDER_STATUS].[All]",
            "[ORDERS].[ORDER_STATUS].&[F]",
            "[ORDERS].[ORDER_STATUS].&[O]",
            "[ORDERS].[ORDER_STATUS].&[P]",
        ]
        # The child members carry the parent pointer Excel asked for.
        leaf = axis0.findall(".//m:Member", NS)[1]
        assert leaf.find("m:PARENT_UNIQUE_NAME", NS).text == "[ORDERS].[ORDER_STATUS].[All]"
        # No measure anywhere: a member-list query answers tuples only.
        # Inventing a default measure broke the moment it could not group
        # by the queried field, so cells are simply absent.
        assert root.findall(".//m:CellData/m:Cell", NS) == []

    def test_drilldown_with_a_where_measure_fills_cells(self, scripted_gateway):
        xml = handle_execute(FakeSession(), FakeRequest(
            DRILL.replace(
                " CELL PROPERTIES",
                " WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE]) CELL PROPERTIES",
            )
        ))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        # All=grand total at ordinal 0, then children; the NULL cell for P
        # is absent rather than empty.
        cells = {c.get("CellOrdinal"): c.find("m:Value", NS).text
                 for c in root.findall(".//m:CellData/m:Cell", NS)}
        assert cells == {"0": "300.75", "1": "100.5", "2": "200.25"}
        # The WHERE measure lands on the slicer.
        slicer = root.find(".//m:Axes/m:Axis[@name='SlicerAxis']", NS)
        assert slicer.find(".//m:UName", NS).text == "[Measures].[ORDERS.TOTAL_ORDER_VALUE]"

    def test_measures_columns_field_rows_ordinals(self, scripted_gateway):
        xml = handle_execute(FakeSession(), FakeRequest(
            "SELECT {[Measures].[ORDERS.TOTAL_ORDER_VALUE]} ON COLUMNS, "
            "NON EMPTY Hierarchize({DrilldownLevel({[ORDERS].[ORDER_STATUS].[All]})}) "
            "ON ROWS FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS]"
        ))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        axes = {a.get("name"): a for a in root.findall(".//m:Axes/m:Axis", NS)}
        assert set(axes) == {"Axis0", "Axis1", "SlicerAxis"}
        # Axis0 = the measure; Axis1 = All + 3 children.
        assert len(axes["Axis0"].findall(".//m:Tuple", NS)) == 1
        assert len(axes["Axis1"].findall(".//m:Tuple", NS)) == 4
        cells = {c.get("CellOrdinal"): c.find("m:Value", NS).text
                 for c in root.findall(".//m:CellData/m:Cell", NS)}
        # ordinal = row * len(axis0) + col with axis0 length 1
        assert cells == {"0": "300.75", "1": "100.5", "2": "200.25"}

    def test_an_unknown_cube_is_a_clean_error(self, scripted_gateway):
        from app.errors import ApiError

        with pytest.raises(ApiError):
            handle_execute(FakeSession(), FakeRequest("SELECT FROM [NOPE]"))
