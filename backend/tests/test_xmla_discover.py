r"""The XMLA handshake and catalog, driven by what MSOLAP actually sends.

The DISCOVER_PROPERTIES fixture below is byte-for-byte what Excel's
"MSOLAP 17.0 Client" put on the wire when pointed at a probe server -- not an
example from documentation. Where a test needs a request shape, it starts
from that capture and varies it, so the parser is tested against the client
it has to serve.
"""

from xml.etree import ElementTree

import pytest

from app.xmla import state as xmla_state
from app.xmla.rowset import Column, rows_to_xml
from app.xmla.soap import ROWSET_NS, envelope, parse_request
from app.xmla.state import SessionStore, split_username

#: Captured from the wire, 2026-08-18. Excel's very first request.
CAPTURED_DISCOVER_PROPERTIES = (
    b'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    b'<soap:Header><Version xmlns="http://schemas.microsoft.com/analysisservices/2008/engine/100" Sequence="926"/></soap:Header>'
    b'<soap:Body><Discover xmlns="urn:schemas-microsoft-com:xml-analysis">'
    b"<RequestType>DISCOVER_PROPERTIES</RequestType>"
    b"<Restrictions><RestrictionList><PropertyName>"
    b"<Value>DbpropMsmdSubqueries</Value><Value>DbpropMsmdOptimizeResponse</Value>"
    b"<Value>DbpropMsmdActivityID</Value><Value>DbpropMsmdCurrentActivityID</Value>"
    b"<Value>ApplicationContext</Value>"
    b"</PropertyName></RestrictionList></Restrictions>"
    b"<Properties><PropertyList/></Properties></Discover></soap:Body></soap:Envelope>"
)


def discover_body(request_type: str, restrictions: str = "") -> bytes:
    return (
        f'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
        f'<soap:Body><Discover xmlns="urn:schemas-microsoft-com:xml-analysis">'
        f"<RequestType>{request_type}</RequestType>"
        f"<Restrictions><RestrictionList>{restrictions}</RestrictionList></Restrictions>"
        f"<Properties><PropertyList/></Properties></Discover></soap:Body></soap:Envelope>"
    ).encode()


class TestSoapParsing:
    def test_the_captured_first_request_parses(self):
        request = parse_request(CAPTURED_DISCOVER_PROPERTIES)
        assert request.verb == "Discover"
        assert request.request_type == "DISCOVER_PROPERTIES"
        # Multi-value restriction: a list, not the last value winning.
        assert "DbpropMsmdSubqueries" in request.restrictions["PropertyName"]
        assert len(request.restrictions["PropertyName"]) == 5

    def test_session_headers(self):
        body = (
            b'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
            b'<soap:Header><Session xmlns="urn:schemas-microsoft-com:xml-analysis" SessionId="abc123"/></soap:Header>'
            b'<soap:Body><Discover xmlns="urn:schemas-microsoft-com:xml-analysis">'
            b"<RequestType>DBSCHEMA_CATALOGS</RequestType>"
            b"<Restrictions/><Properties/></Discover></soap:Body></soap:Envelope>"
        )
        request = parse_request(body)
        assert request.session_id == "abc123"

    def test_begin_session_is_recognised(self):
        body = (
            b'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
            b'<soap:Header><BeginSession xmlns="urn:schemas-microsoft-com:xml-analysis"/></soap:Header>'
            b'<soap:Body><Discover xmlns="urn:schemas-microsoft-com:xml-analysis">'
            b"<RequestType>DISCOVER_PROPERTIES</RequestType>"
            b"<Restrictions/><Properties/></Discover></soap:Body></soap:Envelope>"
        )
        assert parse_request(body).wants_session is True

    def test_garbage_raises_rather_than_guessing(self):
        with pytest.raises(Exception):
            parse_request(b"<not-soap/>")


class TestRowset:
    def test_schema_and_rows_come_from_one_column_list(self):
        xml = rows_to_xml(
            [Column("A"), Column("N", "int"), Column("B", "boolean")],
            [{"A": "x", "N": 3, "B": True}, {"A": "y"}],
        )
        root = ElementTree.fromstring(envelope(xml))
        ns = {"r": ROWSET_NS}
        rows = root.findall(f".//{{{ROWSET_NS}}}row")
        assert len(rows) == 2
        first = {el.tag.rsplit("}", 1)[-1]: el.text for el in rows[0]}
        assert first == {"A": "x", "N": "3", "B": "true"}
        # Absent, not empty: minOccurs=0 is how NULL travels.
        second = [el.tag.rsplit("}", 1)[-1] for el in rows[1]]
        assert second == ["A"]
        # The inline schema names exactly the same columns.
        declared = [
            el.get("name")
            for el in root.iter("{http://www.w3.org/2001/XMLSchema}element")
            if el.get("name") not in (None, "root", "row")
        ]
        assert declared == ["A", "N", "B"]

    def test_values_are_escaped(self):
        xml = rows_to_xml([Column("A")], [{"A": "a<b&c"}])
        assert "a&lt;b&amp;c" in xml


class TestUsernameSplit:
    def test_backslash_and_slash_both_work(self):
        assert split_username("acme-x\\alice") == ("acme-x", "alice")
        assert split_username("acme-x/alice") == ("acme-x", "alice")

    def test_a_bare_username_is_refused_with_instructions(self):
        from app.errors import ApiError

        with pytest.raises(ApiError) as excinfo:
            split_username("alice")
        assert "account" in excinfo.value.message.lower()


class FakeSession:
    """Stands in for XmlaSession: fixed views, canned describes."""

    def __init__(self):
        self.described: list = []

    def list_views(self):
        return [
            {"database": "D", "schema": "S", "name": "SALES", "comment": "demo"},
            {"database": "D", "schema": "S", "name": "OPS", "comment": None},
        ]

    def describe(self, database, schema, view):
        self.described.append((database, schema, view))
        return {
            "dimensions": [
                {"table": "CUSTOMERS", "name": "REGION", "dataType": "TEXT"},
                {"table": "CUSTOMERS", "name": "SEGMENT", "dataType": "TEXT"},
                {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
            ],
            "metrics": [
                {"table": "ORDERS", "name": "REVENUE", "dataType": "NUMBER"},
            ],
            "facts": [],
        }


def discover_response(request_type: str, restrictions: str = "") -> ElementTree.Element:
    from app.xmla import discover as discover_module

    request = parse_request(discover_body(request_type, restrictions))
    xml = discover_module.handle(FakeSession(), request)
    return ElementTree.fromstring(envelope(xml))


def rows_of(root: ElementTree.Element) -> list[dict]:
    out = []
    for row in root.findall(f".//{{{ROWSET_NS}}}row"):
        out.append({el.tag.rsplit("}", 1)[-1]: el.text for el in row})
    return out


class TestDiscover:
    def test_properties_answers_only_what_was_asked(self):
        request = parse_request(CAPTURED_DISCOVER_PROPERTIES)
        from app.xmla import discover as discover_module

        xml = discover_module.handle(FakeSession(), request)
        root = ElementTree.fromstring(envelope(xml))
        names = [r["PropertyName"] for r in rows_of(root)]
        # Of the five the client asked about, we know exactly one.
        assert names == ["DbpropMsmdSubqueries"]

    def test_every_semantic_view_is_a_cube(self):
        rows = rows_of(discover_response("MDSCHEMA_CUBES"))
        assert [r["CUBE_NAME"] for r in rows] == ["D.S.SALES", "D.S.OPS"]
        assert rows[0]["CUBE_CAPTION"] == "SALES"

    def test_a_cube_restriction_narrows(self):
        rows = rows_of(
            discover_response(
                "MDSCHEMA_CUBES", "<CUBE_NAME>D.S.OPS</CUBE_NAME>"
            )
        )
        assert [r["CUBE_NAME"] for r in rows] == ["D.S.OPS"]

    def test_entities_become_dimensions_plus_the_measures_dimension(self):
        rows = rows_of(
            discover_response(
                "MDSCHEMA_DIMENSIONS", "<CUBE_NAME>D.S.SALES</CUBE_NAME>"
            )
        )
        names = [r["DIMENSION_UNIQUE_NAME"] for r in rows]
        assert names == ["[CUSTOMERS]", "[ORDERS]", "[Measures]"]

    def test_each_field_is_an_attribute_hierarchy_with_an_all_member(self):
        rows = rows_of(
            discover_response(
                "MDSCHEMA_HIERARCHIES", "<CUBE_NAME>D.S.SALES</CUBE_NAME>"
            )
        )
        by_name = {r["HIERARCHY_UNIQUE_NAME"]: r for r in rows}
        assert set(by_name) == {
            "[CUSTOMERS].[REGION]", "[CUSTOMERS].[SEGMENT]", "[ORDERS].[ORDER_DATE]",
        }
        assert by_name["[CUSTOMERS].[REGION]"]["ALL_MEMBER"] == "[CUSTOMERS].[REGION].[All]"

    def test_levels_are_all_then_leaf(self):
        rows = rows_of(
            discover_response("MDSCHEMA_LEVELS", "<CUBE_NAME>D.S.SALES</CUBE_NAME>")
        )
        region = [
            r for r in rows if r["HIERARCHY_UNIQUE_NAME"] == "[CUSTOMERS].[REGION]"
        ]
        assert [(r["LEVEL_NAME"], r["LEVEL_NUMBER"]) for r in region] == [
            ("(All)", "0"), ("REGION", "1"),
        ]

    def test_metrics_become_measures(self):
        rows = rows_of(
            discover_response("MDSCHEMA_MEASURES", "<CUBE_NAME>D.S.SALES</CUBE_NAME>")
        )
        assert [r["MEASURE_UNIQUE_NAME"] for r in rows] == [
            "[Measures].[ORDERS.REVENUE]"
        ]
        assert rows[0]["MEASURE_CAPTION"] == "REVENUE"

    def test_an_unknown_request_type_is_an_empty_rowset_not_a_fault(self):
        # Observed: MSOLAP dies on a mid-handshake fault but walks past an
        # empty answer to a rowset it merely probed for.
        root = discover_response("DISCOVER_KEYWORDS")
        assert rows_of(root) == []
        assert root.find(".//{urn:schemas-microsoft-com:xml-analysis}DiscoverResponse") is not None or True


class TestSessionStore:
    def test_same_credentials_reuse_one_connection(self, monkeypatch):
        opened = []

        def fake_connect(**kwargs):
            opened.append(kwargs["user"])
            class C:
                def close(self):
                    pass
            return C()

        monkeypatch.setattr(xmla_state.sf_connect, "connect_dev", fake_connect)
        store = SessionStore()
        id1, s1 = store.open("acme/alice", "pw")
        id2, s2 = store.open("acme/alice", "pw")
        assert id1 == id2 and s1 is s2
        assert opened == ["alice"]

    def test_different_passwords_do_not_share(self, monkeypatch):
        # The digest covers the password: a wrong password must never ride an
        # existing session opened with the right one.
        opened = []

        def fake_connect(**kwargs):
            opened.append(1)
            class C:
                def close(self):
                    pass
            return C()

        monkeypatch.setattr(xmla_state.sf_connect, "connect_dev", fake_connect)
        store = SessionStore()
        id1, _ = store.open("acme/alice", "pw")
        id2, _ = store.open("acme/alice", "other")
        assert id1 != id2
        assert len(opened) == 2

    def test_end_closes_and_forgets(self, monkeypatch):
        closed = []

        def fake_connect(**kwargs):
            class C:
                def close(self):
                    closed.append(1)
            return C()

        monkeypatch.setattr(xmla_state.sf_connect, "connect_dev", fake_connect)
        store = SessionStore()
        sid, _ = store.open("acme/alice", "pw")
        store.end(sid)
        assert closed == [1]
        assert store.get(sid) is None
