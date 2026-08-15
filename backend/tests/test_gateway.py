import pytest
from snowflake.connector.errors import DatabaseError, ProgrammingError

from app.errors import ApiError, AuthExpiredError
from app.snowflake.gateway import map_snowflake_error, run_query
from tests.fakes import FakeCol, FakeConnection, FakeCursor


def test_run_query_shapes_result():
    cur = FakeCursor(
        rows=[("2026-01-01", 10), ("2026-01-02", 20)],
        description=[FakeCol("ORDER_DATE", 3), FakeCol("TOTAL_REVENUE", 0)],
        sfqid="abc-123",
    )
    result = run_query(FakeConnection(cur), "SELECT 1", max_rows=100)
    assert [c["name"] for c in result.columns] == ["ORDER_DATE", "TOTAL_REVENUE"]
    assert all(isinstance(c["type"], str) for c in result.columns)
    assert result.rows == [["2026-01-01", 10], ["2026-01-02", 20]]
    assert result.truncated is False
    assert result.sfqid == "abc-123"


def test_run_query_truncates_at_max_rows():
    cur = FakeCursor(rows=[(i,) for i in range(5)], description=[FakeCol("N")])
    result = run_query(FakeConnection(cur), "SELECT 1", max_rows=3)
    assert len(result.rows) == 3
    assert result.truncated is True


def test_run_query_maps_errors():
    cur = FakeCursor(error=ProgrammingError(msg="Syntax error near X", errno=1003))
    with pytest.raises(ApiError) as exc_info:
        run_query(FakeConnection(cur), "SELECT nonsense", max_rows=10)
    assert exc_info.value.code == "QUERY_ERROR"
    assert exc_info.value.status == 400
    assert "Syntax error" in exc_info.value.message


def test_map_insufficient_privileges_is_403():
    err = map_snowflake_error(
        ProgrammingError(msg="Insufficient privileges to operate on view", errno=3001)
    )
    assert err.code == "SNOWFLAKE_FORBIDDEN"
    assert err.status == 403


def test_map_timeout_is_504():
    err = map_snowflake_error(
        ProgrammingError(msg="Statement reached its statement or warehouse timeout", errno=630)
    )
    assert err.code == "TIMEOUT"
    assert err.status == 504


def test_map_unknown_exception_is_query_error():
    err = map_snowflake_error(RuntimeError("boom"))
    assert err.code == "QUERY_ERROR"
    assert err.status == 400


def test_map_token_expired_errno_390114_is_auth_expired():
    err = map_snowflake_error(
        ProgrammingError(
            msg="Authentication token has expired.  The user must authenticate again.",
            errno=390114,
            sqlstate="08001",
        )
    )
    assert isinstance(err, AuthExpiredError)
    assert err.code == "AUTH_EXPIRED"
    assert err.status == 401


def test_map_session_gone_errno_390111_is_auth_expired():
    err = map_snowflake_error(
        ProgrammingError(msg="Session is gone", errno=390111, sqlstate="08001")
    )
    assert isinstance(err, AuthExpiredError)
    assert err.code == "AUTH_EXPIRED"
    assert err.status == 401


def test_map_sqlstate_08001_family_is_auth_expired():
    # Some client/session-gone errors surface without one of the specific
    # errnos above but still carry the 08001 (connection-does-not-exist /
    # authentication) sqlstate family.
    err = map_snowflake_error(
        DatabaseError(msg="Connection is closed", errno=250006, sqlstate="08001")
    )
    assert isinstance(err, AuthExpiredError)
    assert err.code == "AUTH_EXPIRED"
    assert err.status == 401


def test_map_unrelated_sqlstate_is_not_auth_expired():
    err = map_snowflake_error(
        ProgrammingError(msg="Syntax error near X", errno=1003, sqlstate="42000")
    )
    assert err.code == "QUERY_ERROR"
    assert not isinstance(err, AuthExpiredError)
