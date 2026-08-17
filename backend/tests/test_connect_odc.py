"""The Connect panel's four manual steps, as a file Excel opens.

The two things worth asserting about a connection file are what it contains
(the query) and what it does NOT (any credential).
"""

from app.export.odc import DRIVER, build_odc, filename_for


def odc(**overrides):
    body = {
        "title": "Revenue by region",
        "sql": "SELECT * FROM SEMANTIC_VIEW(db.s.v DIMENSIONS a.b METRICS c.d)",
        "account": "XRIIEIM-EH01350",
        "database": "SEMANTIC_DEMO",
        "schema": "TPCH",
    }
    body.update(overrides)
    return build_odc(**body)


class TestContents:
    def test_it_carries_the_query_and_the_server(self):
        document = odc()
        assert "SEMANTIC_VIEW" in document
        assert "XRIIEIM-EH01350.snowflakecomputing.com" in document
        assert DRIVER in document
        assert "<odc:CommandType>SQL</odc:CommandType>" in document

    def test_a_warehouse_is_included_only_when_asked_for(self):
        assert "Warehouse=" not in odc()
        assert "Warehouse=BI_WH" in odc(warehouse="BI_WH")

    def test_sql_is_escaped_rather_than_breaking_the_document(self):
        # A filter value containing < or & is ordinary; a document it corrupts
        # is not.
        document = odc(sql="SELECT * WHERE x < 5 AND y = 'a&b'")
        assert "x &lt; 5" in document
        assert "'a&amp;b'" in document
        assert "<odc:CommandText>" in document


class TestCredentials:
    def test_no_password_reaches_the_file(self):
        # The product's whole premise is that every query runs on the caller's
        # own credentials. A connection file carrying one would break that the
        # first time a workbook was forwarded -- so there is nowhere in this
        # builder to put a secret, and this is the test that keeps it that way.
        document = odc().lower()
        for word in ("password", "pwd=", "uid=", "token", "authenticator"):
            assert word not in document

    def test_it_does_not_persist_security_info(self):
        assert "Persist Security Info=False" in odc()


class TestFilename:
    def test_it_is_named_after_the_visual(self):
        assert filename_for("Revenue by region") == "Revenue by region.odc"

    def test_it_strips_what_a_filesystem_would_refuse(self):
        assert filename_for('a/b:c*d?"e') == "a_b_c_d__e.odc"

    def test_an_empty_title_still_produces_a_name(self):
        assert filename_for("") == "query.odc"
        assert filename_for("///") == "query.odc"
