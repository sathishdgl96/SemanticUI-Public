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


#: Verbatim wire capture (2026-08-18): Excel collapsing the F group of a
#: STATUS -> PRIORITY nested pivot. {-{...&[F]}} is the complement set.
COLLAPSE = (
    "SELECT NON EMPTY Hierarchize(DrilldownMember(CrossJoin("
    "{[ORDERS].[ORDER_STATUS].[All],[ORDERS].[ORDER_STATUS].[ORDER_STATUS].Members}, "
    "{([ORDERS].[ORDER_PRIORITY].[All])}), "
    "{-{[ORDERS].[ORDER_STATUS].&[F]}}, [ORDERS].[ORDER_PRIORITY])) "
    "DIMENSION PROPERTIES PARENT_UNIQUE_NAME,HIERARCHY_UNIQUE_NAME ON COLUMNS "
    "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS] "
    "WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE]) "
    "CELL PROPERTIES VALUE, FORMAT_STRING, LANGUAGE, BACK_COLOR, FORE_COLOR, FONT_FLAGS"
)


class TwoFieldSession(FakeSession):
    def describe(self, database, schema, view):
        return {
            "dimensions": [
                {"table": "ORDERS", "name": "ORDER_STATUS", "dataType": "TEXT"},
                {"table": "ORDERS", "name": "ORDER_PRIORITY", "dataType": "TEXT"},
            ],
            "metrics": [
                {"table": "ORDERS", "name": "TOTAL_ORDER_VALUE", "dataType": "NUMBER"},
            ],
            "facts": [],
            "tables": [{"name": "ORDERS"}],
            "relationships": [],
        }


@pytest.fixture
def two_field_gateway(monkeypatch):
    def fake_run_query(conn, sql, *, max_rows, params=None):
        upper = sql.upper()
        has_status = "ORDER_STATUS" in upper
        has_priority = "ORDER_PRIORITY" in upper
        if has_status and has_priority:
            return QueryResult(
                columns=[], truncated=False, sfqid=None,
                rows=[["F", "HIGH", 1], ["F", "LOW", 2],
                      ["O", "HIGH", 3], ["O", "LOW", 4]],
            )
        if has_status:
            return QueryResult(
                columns=[], truncated=False, sfqid=None,
                rows=[["F", 3], ["O", 7]],
            )
        if has_priority:
            return QueryResult(
                columns=[], truncated=False, sfqid=None,
                rows=[["HIGH", 4], ["LOW", 6]],
            )
        return QueryResult(columns=[], rows=[[10]], truncated=False, sfqid=None)

    monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)


class TestCollapse:
    def test_the_collapse_capture_parses(self):
        q = parse_mdx(COLLAPSE)
        assert len(q.axes) == 1

    def test_a_collapsed_group_keeps_its_subtotal_but_loses_its_children(
        self, two_field_gateway
    ):
        xml = handle_execute(TwoFieldSession(), FakeRequest(COLLAPSE))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        axis0 = root.find(".//m:Axes/m:Axis[@name='Axis0']", NS)
        tuples = [
            tuple(m.find("m:UName", NS).text for m in t.findall("m:Member", NS))
            for t in axis0.findall(".//m:Tuple", NS)
        ]
        f_rows = [t for t in tuples if t[0] == "[ORDERS].[ORDER_STATUS].&[F]"]
        o_rows = [t for t in tuples if t[0] == "[ORDERS].[ORDER_STATUS].&[O]"]
        # F stays as a single subtotal row; O is expanded into priorities.
        assert [t[1] for t in f_rows] == ["[ORDERS].[ORDER_PRIORITY].[All]"]
        assert "[ORDERS].[ORDER_PRIORITY].&[HIGH]" in [t[1] for t in o_rows]


class TestFilterDropdownShapes:
    """The queries behind Excel's filter dropdown tree."""

    def test_children_of_a_leaf_is_empty_not_the_whole_level(
        self, two_field_gateway
    ):
        # Expanding F must NOT answer the status list again -- a leaf of a
        # two-level attribute hierarchy has no children.
        xml = handle_execute(TwoFieldSession(), FakeRequest(
            "SELECT {AddCalculatedMembers([ORDERS].[ORDER_STATUS].&[F].Children)} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS]"
        ))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        assert root.find(".//m:Axes/m:Axis[@name='Axis0']", NS) is None

    def test_exists_scopes_a_level_to_the_expanded_member(self, monkeypatch):
        captured = []

        def fake_run_query(conn, sql, *, max_rows, params=None):
            captured.append((sql, list(params or [])))
            return QueryResult(
                columns=[], rows=[["HIGH"], ["LOW"]], truncated=False, sfqid=None,
            )

        monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)
        xml = handle_execute(TwoFieldSession(), FakeRequest(
            "SELECT {Exists(AddCalculatedMembers("
            "[ORDERS].[ORDER_PRIORITY].[ORDER_PRIORITY].Members), "
            "{[ORDERS].[ORDER_STATUS].&[F]})} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS]"
        ))
        # The expanded member reached the SQL as a bound filter value.
        assert any("F" in params for _, params in captured)
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        unames = [m.find("m:UName", NS).text
                  for m in root.findall(".//m:Axes/m:Axis[@name='Axis0']//m:Member", NS)]
        assert unames == [
            "[ORDERS].[ORDER_PRIORITY].&[HIGH]",
            "[ORDERS].[ORDER_PRIORITY].&[LOW]",
        ]

    def test_a_fixed_member_crossjoined_with_a_level_stays_scoped(
        self, two_field_gateway
    ):
        # The other dropdown shape: CrossJoin({F}, priority.Members) with
        # NON EMPTY -- only combinations the data produces come back.
        xml = handle_execute(TwoFieldSession(), FakeRequest(
            "SELECT NON EMPTY CrossJoin({[ORDERS].[ORDER_STATUS].&[F]}, "
            "AddCalculatedMembers([ORDERS].[ORDER_PRIORITY].[ORDER_PRIORITY].Members)) "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS]"
        ))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        tuples = [
            tuple(m.find("m:UName", NS).text for m in t.findall("m:Member", NS))
            for t in root.findall(".//m:Axes/m:Axis[@name='Axis0']/m:Tuples/m:Tuple", NS)
        ]
        assert all(t[0] == "[ORDERS].[ORDER_STATUS].&[F]" for t in tuples)
        assert {t[1] for t in tuples} == {
            "[ORDERS].[ORDER_PRIORITY].&[HIGH]",
            "[ORDERS].[ORDER_PRIORITY].&[LOW]",
        }


class TestTupleFilters:
    """Excel's per-tuple filter: uncheck one child under one parent only.

    The kept combinations arrive as TUPLES in the subselect; they must
    reach Snowflake as one (fields) IN ((values), ...) predicate so every
    aggregate -- leaf, subtotal, grand total -- is recomputed over exactly
    the kept combinations.
    """

    KEPT_TUPLES = (
        "SELECT NON EMPTY CrossJoin("
        "Hierarchize(AddCalculatedMembers({DrilldownLevel({[ORDERS].[ORDER_STATUS].[All]})})), "
        "Hierarchize(AddCalculatedMembers({DrilldownLevel({[ORDERS].[ORDER_PRIORITY].[All]})}))"
        ") DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
        "FROM (SELECT ({"
        "([ORDERS].[ORDER_STATUS].&[F],[ORDERS].[ORDER_PRIORITY].&[LOW]), "
        "([ORDERS].[ORDER_STATUS].&[O],[ORDERS].[ORDER_PRIORITY].&[HIGH]), "
        "([ORDERS].[ORDER_STATUS].&[O],[ORDERS].[ORDER_PRIORITY].&[LOW])"
        "}) ON COLUMNS FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS]) "
        "WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE])"
    )

    def test_tuples_parse_without_flattening(self):
        q = parse_mdx(self.KEPT_TUPLES)
        entries = q.subselect_filters[0]
        assert all(isinstance(e, tuple) and e[0] == "tuple" for e in entries)

    def test_kept_tuples_become_one_bound_combo_predicate(self, monkeypatch):
        captured = []

        def fake_run_query(conn, sql, *, max_rows, params=None):
            captured.append((sql, list(params or [])))
            # Route on the DIMENSIONS clause: the combo predicate mentions
            # both columns in EVERY statement, so bare substrings lie.
            import re as _re

            m = _re.search(r"DIMENSIONS (.*?)(?:METRICS|WHERE|$)", sql, _re.S)
            dims = m.group(1) if m else ""
            has_status = "ORDER_STATUS" in dims
            has_priority = "ORDER_PRIORITY" in dims
            if has_status and has_priority:
                rows = [["F", "LOW", 2], ["O", "HIGH", 3], ["O", "LOW", 4]]
            elif has_status:
                rows = [["F", 2], ["O", 7]]
            elif has_priority:
                rows = [["HIGH", 3], ["LOW", 6]]
            else:
                rows = [[9]]
            return QueryResult(columns=[], rows=rows, truncated=False, sfqid=None)

        monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)
        xml = handle_execute(TwoFieldSession(), FakeRequest(self.KEPT_TUPLES))

        # EVERY query carried the combo predicate, values bound.
        for sql, params in captured:
            assert ") IN ((" in sql
            assert "F" in params and "LOW" in params
            assert "'F'" not in sql
        # The unkept combination (F, HIGH) never appears on the axis.
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        tuples = [
            tuple(m.find("m:UName", NS).text for m in t.findall("m:Member", NS))
            for t in root.findall(".//m:Axes/m:Axis[@name='Axis0']/m:Tuples/m:Tuple", NS)
        ]
        leaf_pairs = {
            (t[0], t[1]) for t in tuples
            if "&" in t[0] and "&" in t[1]
        }
        assert ("[ORDERS].[ORDER_STATUS].&[F]",
                "[ORDERS].[ORDER_PRIORITY].&[HIGH]") not in leaf_pairs
        assert ("[ORDERS].[ORDER_STATUS].&[O]",
                "[ORDERS].[ORDER_PRIORITY].&[HIGH]") in leaf_pairs


class GeoSession(FakeSession):
    """Three-level user hierarchy Geo: REGION -> NATION -> CUSTOMER_NAME."""

    def describe(self, database, schema, view):
        return {
            "dimensions": [
                {"table": "CUSTOMERS", "name": "REGION", "dataType": "TEXT"},
                {"table": "CUSTOMERS", "name": "NATION", "dataType": "TEXT"},
                {"table": "CUSTOMERS", "name": "CUSTOMER_NAME", "dataType": "TEXT"},
            ],
            "metrics": [
                {"table": "ORDERS", "name": "TOTAL_ORDER_VALUE", "dataType": "NUMBER"},
            ],
            "facts": [],
            "tables": [{"name": "CUSTOMERS"}, {"name": "ORDERS"}],
            "relationships": [],
        }

    def user_hierarchies(self, view):
        return [{
            "name": "Geo", "home": "CUSTOMERS",
            "levels": [("CUSTOMERS", "REGION"), ("CUSTOMERS", "NATION"),
                       ("CUSTOMERS", "CUSTOMER_NAME")],
        }]


@pytest.fixture
def geo_gateway(monkeypatch):
    data = [
        ["EUROPE", "FRANCE", "C1", 10],
        ["EUROPE", "FRANCE", "C2", 5],
        ["EUROPE", "GERMANY", "C3", 7],
        ["ASIA", "JAPAN", "C4", 3],
    ]

    def fake_run_query(conn, sql, *, max_rows, params=None):
        import re as _re

        m = _re.search(r"DIMENSIONS (.*?)(?:METRICS|WHERE|$)", sql, _re.S)
        dims = m.group(1) if m else ""
        cols = [n for n in ("REGION", "NATION", "CUSTOMER_NAME") if n in dims]
        has_metric = "METRICS" in sql
        idx = {"REGION": 0, "NATION": 1, "CUSTOMER_NAME": 2}
        seen = {}
        for row in data:
            key = tuple(row[idx[c]] for c in cols)
            seen[key] = seen.get(key, 0) + row[3]
        rows = [list(k) + ([v] if has_metric else [])
                for k, v in sorted(seen.items())]
        if not cols:
            rows = [[sum(r[3] for r in data)]] if has_metric else [[]]
        return QueryResult(columns=[], rows=rows, truncated=False, sfqid=None)

    monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)


def axis_members(xml):
    root = ElementTree.fromstring(xml).find(".//m:root", NS)
    out = []
    for t in root.findall(".//m:Axes/m:Axis[@name='Axis0']/m:Tuples/m:Tuple", NS):
        m = t.find("m:Member", NS)
        out.append((
            m.find("m:UName", NS).text,
            int(m.find("m:LNum", NS).text),
            int(m.find("m:DisplayInfo", NS).text),
        ))
    return out


class TestUserHierarchy:
    def test_expanding_level_one_shows_level_two(self, geo_gateway):
        xml = handle_execute(GeoSession(), FakeRequest(
            "SELECT {AddCalculatedMembers([CUSTOMERS].[Geo].&[EUROPE].Children)} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS]"
        ))
        members = axis_members(xml)
        assert [m[0] for m in members] == [
            "[CUSTOMERS].[Geo].&[EUROPE].&[FRANCE]",
            "[CUSTOMERS].[Geo].&[EUROPE].&[GERMANY]",
        ]
        # Level 2 of 3: still expandable, so the + must be offered.
        assert all(m[1] == 2 and m[2] != 0 for m in members)

    def test_expanding_level_two_shows_level_three_as_leaves(self, geo_gateway):
        xml = handle_execute(GeoSession(), FakeRequest(
            "SELECT {AddCalculatedMembers("
            "[CUSTOMERS].[Geo].&[EUROPE].&[FRANCE].Children)} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS]"
        ))
        members = axis_members(xml)
        assert [m[0] for m in members] == [
            "[CUSTOMERS].[Geo].&[EUROPE].&[FRANCE].&[C1]",
            "[CUSTOMERS].[Geo].&[EUROPE].&[FRANCE].&[C2]",
        ]
        assert all(m[1] == 3 and m[2] == 0 for m in members)

    def test_drilling_the_hierarchy_on_an_axis(self, geo_gateway):
        xml = handle_execute(GeoSession(), FakeRequest(
            "SELECT NON EMPTY Hierarchize(DrilldownMember("
            "{DrilldownLevel({[CUSTOMERS].[Geo].[All]})}, "
            "{[CUSTOMERS].[Geo].&[EUROPE]})) "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            "FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS] "
            "WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE])"
        ))
        members = axis_members(xml)
        unames = [m[0] for m in members]
        assert unames == [
            "[CUSTOMERS].[Geo].[All]",
            "[CUSTOMERS].[Geo].&[ASIA]",
            "[CUSTOMERS].[Geo].&[EUROPE]",
            "[CUSTOMERS].[Geo].&[EUROPE].&[FRANCE]",
            "[CUSTOMERS].[Geo].&[EUROPE].&[GERMANY]",
        ]  # Hierarchize: siblings in query order, children after parents
        # EUROPE is flagged drilled; ASIA is not.
        by_name = {m[0]: m[2] for m in members}
        assert by_name["[CUSTOMERS].[Geo].&[EUROPE]"] & 0x10000
        assert not by_name["[CUSTOMERS].[Geo].&[ASIA]"] & 0x10000
        # Cells: All=25, ASIA=3, EUROPE=22, FRANCE=15, GERMANY=7.
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        cells = {int(c.get("CellOrdinal")): c.find("m:Value", NS).text
                 for c in root.findall(".//m:CellData/m:Cell", NS)}
        assert cells == {0: "25", 1: "3", 2: "22", 3: "15", 4: "7"}
