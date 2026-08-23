"""User-hierarchy filtering and typing fixes, driven by the reported symptoms.

Four defects, each with the Excel gesture that exposes it:

* Paths parsed from MDX are STRINGS; grouping tables hold RAW values.
  On a numeric or date level every prefix/drill/dedupe comparison
  silently failed -- expanding a year showed nothing, collapse state
  was forgotten. Comparisons are now canonical (stringified).
* Exists(set, {[H].[All]}) filtered on the literal value 'All' -- the
  scoping member that means "no constraint" emptied the whole list.
* Exists over several multi-level paths dissolved into per-field IN
  lists, bleeding children across branches (the cartesian). Same-depth
  paths now travel as one (fields) IN ((values), ...) combination.
* A subselect naming user-hierarchy PATHS was ignored outright --
  checking boxes in a hierarchy's filter dropdown filtered nothing.
  Paths now become tuple-IN predicates; branch selections shallower
  than the deepest selection are expanded to full paths first.

Plus: DrilldownMember's drill set re-walked members already on the
base axis, duplicating rows on explicitly-filtered pivots.
"""

from xml.etree import ElementTree

from app.snowflake.gateway import QueryResult
from app.xmla import execute as execute_module
from app.xmla.execute import handle_execute
from tests.test_xmla_execute import (
    NS,
    FakeRequest,
    FakeSession,
    GeoSession,
    TwoFieldSession,
    axis_members,
)

CUBE = "SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS"


class CalSession(FakeSession):
    """Two-level user hierarchy over NUMERIC columns: YEAR -> MONTH."""

    def describe(self, database, schema, view):
        return {
            "dimensions": [
                {"table": "ORDERS", "name": "ORDER_YEAR", "dataType": "NUMBER"},
                {"table": "ORDERS", "name": "ORDER_MONTH", "dataType": "NUMBER"},
            ],
            "metrics": [
                {"table": "ORDERS", "name": "TOTAL_ORDER_VALUE", "dataType": "NUMBER"},
            ],
            "facts": [],
            "tables": [{"name": "ORDERS"}],
            "relationships": [],
        }

    def user_hierarchies(self, view):
        return [{
            "name": "Cal", "home": "ORDERS",
            "levels": [("ORDERS", "ORDER_YEAR"), ("ORDERS", "ORDER_MONTH")],
        }]


GEO_DATA = [
    ["EUROPE", "FRANCE", "C1", 10],
    ["EUROPE", "FRANCE", "C2", 5],
    ["EUROPE", "GERMANY", "C3", 7],
    ["ASIA", "JAPAN", "C4", 3],
]


def _grouping_gateway(monkeypatch, columns, data, captured=None):
    """A fake gateway that answers any grouping over `columns` from `data`
    (raw values preserved -- ints stay ints), recording each call."""
    import re as _re

    idx = {name: i for i, name in enumerate(columns)}

    def fake_run_query(conn, sql, *, max_rows, params=None):
        if captured is not None:
            captured.append((sql, list(params or [])))
        m = _re.search(r"DIMENSIONS (.*?)(?:METRICS|WHERE|$)", sql, _re.S)
        dims = m.group(1) if m else ""
        cols = [n for n in columns if n in dims]
        has_metric = "METRICS" in sql
        seen: dict = {}
        for row in data:
            key = tuple(row[idx[c]] for c in cols)
            seen[key] = seen.get(key, 0) + row[-1]
        rows = [list(k) + ([v] if has_metric else [])
                for k, v in sorted(seen.items(), key=lambda kv: tuple(map(str, kv[0])))]
        if not cols:
            rows = [[sum(r[-1] for r in data)]] if has_metric else [[]]
        return QueryResult(columns=[], rows=rows, truncated=False, sfqid=None)

    monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)


class TestNumericLevelPaths:
    """MDX paths are strings; the data is not. Comparisons must not care."""

    def test_expanding_a_numeric_member_shows_its_children(self, monkeypatch):
        _grouping_gateway(
            monkeypatch, ["ORDER_YEAR", "ORDER_MONTH"],
            [[2023, 1, 4], [2023, 2, 6], [2024, 1, 5]],
        )
        xml = handle_execute(CalSession(), FakeRequest(
            "SELECT {AddCalculatedMembers([ORDERS].[Cal].&[2023].Children)} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            f"FROM [{CUBE}]"
        ))
        members = axis_members(xml)
        assert [m[0] for m in members] == [
            "[ORDERS].[Cal].&[2023].&[1]",
            "[ORDERS].[Cal].&[2023].&[2]",
        ]

    def test_a_numeric_drill_expands_and_keeps_its_flag(self, monkeypatch):
        _grouping_gateway(
            monkeypatch, ["ORDER_YEAR", "ORDER_MONTH"],
            [[2023, 1, 4], [2023, 2, 6], [2024, 1, 5]],
        )
        xml = handle_execute(CalSession(), FakeRequest(
            "SELECT NON EMPTY Hierarchize(DrilldownMember("
            "{DrilldownLevel({[ORDERS].[Cal].[All]})}, {[ORDERS].[Cal].&[2023]})) "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            f"FROM [{CUBE}] "
            "WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE])"
        ))
        members = axis_members(xml)
        unames = [m[0] for m in members]
        assert unames == [
            "[ORDERS].[Cal].[All]",
            "[ORDERS].[Cal].&[2023]",
            "[ORDERS].[Cal].&[2023].&[1]",
            "[ORDERS].[Cal].&[2023].&[2]",
            "[ORDERS].[Cal].&[2024]",
        ]
        by_name = {m[0]: m[2] for m in members}
        assert by_name["[ORDERS].[Cal].&[2023]"] & 0x10000
        assert not by_name["[ORDERS].[Cal].&[2024]"] & 0x10000

    def test_a_named_numeric_member_is_not_pruned_or_duplicated(self, monkeypatch):
        _grouping_gateway(
            monkeypatch, ["ORDER_YEAR", "ORDER_MONTH"],
            [[2023, 1, 4], [2023, 2, 6], [2024, 1, 5]],
        )
        # The member arrives as a parsed string "2023"; NON EMPTY and the
        # cell lookup must still find the (2023,) grouping row.
        xml = handle_execute(CalSession(), FakeRequest(
            "SELECT NON EMPTY Hierarchize(DrilldownMember("
            "{{[ORDERS].[Cal].&[2023]}}, {[ORDERS].[Cal].&[2023]})) "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            f"FROM [{CUBE}] "
            "WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE])"
        ))
        members = axis_members(xml)
        unames = [m[0] for m in members]
        assert unames == [
            "[ORDERS].[Cal].&[2023]",
            "[ORDERS].[Cal].&[2023].&[1]",
            "[ORDERS].[Cal].&[2023].&[2]",
        ]
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        cells = [c.find("m:Value", NS).text
                 for c in root.findall(".//m:CellData/m:Cell", NS)]
        assert cells == ["10", "4", "6"]


class TestExistsScoping:
    def test_exists_on_the_all_member_constrains_nothing(self, monkeypatch):
        captured: list = []
        _grouping_gateway(monkeypatch, ["REGION", "NATION", "CUSTOMER_NAME"],
                          GEO_DATA, captured)
        xml = handle_execute(GeoSession(), FakeRequest(
            "SELECT {Exists(AddCalculatedMembers("
            "{[CUSTOMERS].[Geo].[REGION].Members}), {[CUSTOMERS].[Geo].[All]})} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            f"FROM [{CUBE}]"
        ))
        assert all("All" not in params for _, params in captured)
        members = axis_members(xml)
        assert [m[0] for m in members] == [
            "[CUSTOMERS].[Geo].&[ASIA]",
            "[CUSTOMERS].[Geo].&[EUROPE]",
        ]

    def test_exists_on_an_attribute_all_member_constrains_nothing(
        self, monkeypatch
    ):
        captured: list = []

        def fake_run_query(conn, sql, *, max_rows, params=None):
            captured.append((sql, list(params or [])))
            return QueryResult(columns=[], rows=[["HIGH"], ["LOW"]],
                               truncated=False, sfqid=None)

        monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)
        handle_execute(TwoFieldSession(), FakeRequest(
            "SELECT {Exists(AddCalculatedMembers("
            "[ORDERS].[ORDER_PRIORITY].[ORDER_PRIORITY].Members), "
            "{[ORDERS].[ORDER_STATUS].[All]})} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            f"FROM [{CUBE}]"
        ))
        assert all("All" not in params for _, params in captured)

    def test_two_branches_stay_tuples_not_a_cartesian(self, monkeypatch):
        captured: list = []
        _grouping_gateway(monkeypatch, ["REGION", "NATION", "CUSTOMER_NAME"],
                          GEO_DATA, captured)
        handle_execute(GeoSession(), FakeRequest(
            "SELECT {Exists(AddCalculatedMembers({[CUSTOMERS].[Geo].[CUSTOMER_NAME].Members}), "
            "{[CUSTOMERS].[Geo].&[EUROPE].&[FRANCE], [CUSTOMERS].[Geo].&[ASIA].&[JAPAN]})} "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            f"FROM [{CUBE}]"
        ))
        # One (REGION, NATION) IN ((?, ?), (?, ?)) predicate: FRANCE bound
        # right after EUROPE, JAPAN right after ASIA -- never four
        # independent values that would also admit (EUROPE, JAPAN).
        combo_calls = [
            (sql, params) for sql, params in captured
            if "IN ((?, ?), (?, ?))" in sql
        ]
        assert combo_calls, f"no tuple-IN predicate in: {[s for s, _ in captured]}"
        _, params = combo_calls[0]
        joined = ",".join(str(p) for p in params)
        assert "EUROPE,FRANCE" in joined
        assert "ASIA,JAPAN" in joined


class TestUserHierarchySubselect:
    """Checking boxes in a hierarchy dropdown = a subselect of PATHS."""

    def test_same_depth_paths_become_one_tuple_in(self, monkeypatch):
        captured: list = []
        _grouping_gateway(monkeypatch, ["REGION", "NATION", "CUSTOMER_NAME"],
                          GEO_DATA, captured)
        handle_execute(GeoSession(), FakeRequest(
            "SELECT {[Measures].[ORDERS.TOTAL_ORDER_VALUE]} ON COLUMNS "
            "FROM (SELECT ({[CUSTOMERS].[Geo].&[EUROPE].&[FRANCE],"
            "[CUSTOMERS].[Geo].&[EUROPE].&[GERMANY]}) ON COLUMNS "
            f"FROM [{CUBE}])"
        ))
        combo_calls = [
            (sql, params) for sql, params in captured
            if "IN ((?, ?), (?, ?))" in sql
        ]
        assert combo_calls, "the subselect paths never reached SQL"
        _, params = combo_calls[0]
        joined = ",".join(str(p) for p in params)
        assert "EUROPE,FRANCE" in joined
        assert "EUROPE,GERMANY" in joined

    def test_mixed_depth_selections_expand_to_full_paths(self, monkeypatch):
        captured: list = []
        _grouping_gateway(monkeypatch, ["REGION", "NATION", "CUSTOMER_NAME"],
                          GEO_DATA, captured)
        # A whole branch (ASIA) checked alongside one nation: the branch
        # expands to its nations so one tuple-IN carries both selections.
        handle_execute(GeoSession(), FakeRequest(
            "SELECT {[Measures].[ORDERS.TOTAL_ORDER_VALUE]} ON COLUMNS "
            "FROM (SELECT ({[CUSTOMERS].[Geo].&[ASIA],"
            "[CUSTOMERS].[Geo].&[EUROPE].&[FRANCE]}) ON COLUMNS "
            f"FROM [{CUBE}])"
        ))
        combo_calls = [
            (sql, params) for sql, params in captured
            if "IN ((?, ?), (?, ?))" in sql
        ]
        assert combo_calls, "the mixed-depth selection never reached SQL"
        _, params = combo_calls[0]
        joined = ",".join(str(p) for p in params)
        assert "ASIA,JAPAN" in joined
        assert "EUROPE,FRANCE" in joined


class TestDrillSetDuplicates:
    def test_a_drilled_member_already_on_the_axis_is_not_duplicated(
        self, monkeypatch
    ):
        _grouping_gateway(
            monkeypatch, ["ORDER_STATUS", "ORDER_PRIORITY"],
            [["F", "HIGH", 1], ["F", "LOW", 2],
             ["O", "HIGH", 3], ["O", "LOW", 4]],
        )
        xml = handle_execute(TwoFieldSession(), FakeRequest(
            "SELECT NON EMPTY Hierarchize(DrilldownMember("
            "{{[ORDERS].[ORDER_STATUS].&[F],[ORDERS].[ORDER_STATUS].&[O]}}, "
            "{[ORDERS].[ORDER_STATUS].&[F]}, [ORDERS].[ORDER_PRIORITY])) "
            "DIMENSION PROPERTIES PARENT_UNIQUE_NAME ON COLUMNS "
            f"FROM [{CUBE}] "
            "WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE])"
        ))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        tuples = [
            tuple(m.find("m:UName", NS).text for m in t.findall("m:Member", NS))
            for t in root.findall(
                ".//m:Axes/m:Axis[@name='Axis0']/m:Tuples/m:Tuple", NS)
        ]
        assert len(tuples) == len(set(tuples)), f"duplicate tuples: {tuples}"
