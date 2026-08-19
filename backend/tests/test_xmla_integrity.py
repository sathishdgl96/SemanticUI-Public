"""Two ways the adapter could answer WRONG rather than fail.

* A grouping larger than the row cap came back truncated and was used
  anyway: Excel then drew subtotals and grand totals computed from part
  of the data, with nothing to say so. Wrong numbers that look right are
  worse than an error, so the engine refuses instead.
* A member value containing "]" produced a unique name Excel cannot
  parse back (the MDX escape is "]]"). Every later gesture on that
  member -- drill, collapse, filter -- arrives unreadable.
"""

import pytest

from app.errors import ApiError
from app.snowflake.gateway import QueryResult
from app.xmla import execute as execute_module
from app.xmla.execute import handle_execute
from app.xmla.mdx import parse_mdx
from tests.test_xmla_execute import (
    NS,
    FakeRequest,
    FakeSession,
    axis_members,
)
from xml.etree import ElementTree

CUBE = "SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS"
DRILL = (
    "SELECT NON EMPTY Hierarchize(AddCalculatedMembers({DrilldownLevel("
    "{[ORDERS].[ORDER_STATUS].[All]})})) ON COLUMNS "
    f"FROM [{CUBE}] "
    "WHERE ([Measures].[ORDERS.TOTAL_ORDER_VALUE])"
)


class TestTruncation:
    def test_a_truncated_grouping_is_refused_not_answered(self, monkeypatch):
        def fake_run_query(conn, sql, *, max_rows, params=None):
            return QueryResult(
                columns=[], rows=[["F", 1], ["O", 2]],
                truncated=True, sfqid="q-1",
            )

        monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)
        with pytest.raises(ApiError) as caught:
            handle_execute(FakeSession(), FakeRequest(DRILL))
        # Actionable, and it names no data value.
        assert "too many rows" in caught.value.message.lower()
        assert "F" not in caught.value.message.split()

    def test_an_untruncated_grouping_still_answers(self, monkeypatch):
        def fake_run_query(conn, sql, *, max_rows, params=None):
            return QueryResult(
                columns=[], rows=[["F", 1], ["O", 2]],
                truncated=False, sfqid="q-1",
            )

        monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)
        xml = handle_execute(FakeSession(), FakeRequest(DRILL))
        assert "[ORDERS].[ORDER_STATUS].&[F]" in [m[0] for m in axis_members(xml)]


class TestBracketEscaping:
    def test_a_value_with_a_bracket_round_trips(self, monkeypatch):
        def fake_run_query(conn, sql, *, max_rows, params=None):
            return QueryResult(
                columns=[], rows=[["A]B", 1]], truncated=False, sfqid=None,
            )

        monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)
        xml = handle_execute(FakeSession(), FakeRequest(DRILL))
        unames = [m[0] for m in axis_members(xml)]
        assert "[ORDERS].[ORDER_STATUS].&[A]]B]" in unames

        # The name we emit is a name our own parser reads back -- which is
        # what Excel does with it on the next drill or filter gesture.
        q = parse_mdx(
            "SELECT {[ORDERS].[ORDER_STATUS].&[A]]B]} ON COLUMNS "
            f"FROM [{CUBE}]"
        )
        assert q.axes[0][0].parts == ["ORDERS", "ORDER_STATUS", "A]B"]

    def test_the_slicer_escapes_the_same_way(self, monkeypatch):
        def fake_run_query(conn, sql, *, max_rows, params=None):
            return QueryResult(columns=[], rows=[[7]], truncated=False, sfqid=None)

        monkeypatch.setattr(execute_module.gateway, "run_query", fake_run_query)
        xml = handle_execute(FakeSession(), FakeRequest(
            "SELECT FROM " f"[{CUBE}] "
            "WHERE ([ORDERS].[ORDER_STATUS].&[A]]B], "
            "[Measures].[ORDERS.TOTAL_ORDER_VALUE])"
        ))
        root = ElementTree.fromstring(xml).find(".//m:root", NS)
        unames = [m.find("m:UName", NS).text
                  for m in root.findall(".//m:Axes/m:Axis//m:Member", NS)]
        assert "[ORDERS].[ORDER_STATUS].&[A]]B]" in unames
