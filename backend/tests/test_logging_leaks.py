"""ADR 0007 in the places the original never-log-data test could not see.

`test_logging.py` greps captured app logs for tokens and passwords. It
cannot see three things, and a security review found all three:

* uvicorn's access line, which logs the QUERY STRING -- so the new
  library search term, and an OAuth authorization code, were written on
  every request.
* the raw MDX statement, which encodes a pivot's selected member VALUES.
* a session id, which IS the cookie secret, in a warning.
"""

import logging

from app.auth import sessions as sessions_mod
from app.logging import setup_logging


class TestUvicornAccessLine:
    def test_the_access_logger_does_not_borrow_our_handlers(self):
        """Re-parenting uvicorn.access onto the root handler makes its
        `hasHandlers()` true, which is exactly what makes it emit the
        path WITH query string. Our own request line already logs the
        path and carries the request id."""
        setup_logging("json")
        access = logging.getLogger("uvicorn.access")
        assert access.propagate is False


class TestSessionIdIsNeverWritten:
    def test_a_vanished_session_is_logged_by_reference(self, db, caplog):
        from app.auth.sessions import create_session

        sess = create_session(db, account="ACME", user="ALICE", mode="dev")
        secret = sess.id
        db.delete(sess)
        db.commit()

        with caplog.at_level(logging.WARNING):
            # Touching a row that is already gone is the branch that
            # used to write the cookie value into the log.
            sessions_mod._commit_or_stale(db, secret)
        assert secret not in caplog.text


class TestMdxIsNotWrittenVerbatim:
    def test_the_statement_text_never_reaches_the_log(self, client, db, caplog):
        import base64

        from app.auth import connect_token
        from app.auth.sessions import create_session
        from app.snowflake.provider import get_cache
        from tests.test_semantic_routes import ScriptedConnection

        sess = create_session(db, account="ACME", user="ALICE", mode="dev")
        raw, _ = connect_token.mint(db, sess)
        db.commit()
        get_cache().put(sess.id, ScriptedConnection())

        # A slicer selection: the member key is data the user chose, and
        # it sits well inside the 120 characters that used to be logged.
        statement = (
            "SELECT FROM [SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS] "
            "WHERE ([ORDERS].[ORDER_STATUS].&amp;[SECRETVALUE])"
        )
        body = (
            '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
            '<soap:Body><Execute xmlns="urn:schemas-microsoft-com:xml-analysis">'
            f"<Command><Statement>{statement}</Statement></Command>"
            "<Properties><PropertyList/></Properties>"
            "</Execute></soap:Body></soap:Envelope>"
        ).encode()
        auth = base64.b64encode(f"token:{raw}".encode()).decode()

        with caplog.at_level(logging.INFO):
            client.post(
                "/xmla", content=body,
                headers={"Content-Type": "text/xml", "Authorization": f"Basic {auth}"},
            )
        # Non-vacuous: the request must actually have been handled and
        # logged, or this asserts nothing at all.
        assert "Execute" in caplog.text
        assert "SECRETVALUE" not in caplog.text
