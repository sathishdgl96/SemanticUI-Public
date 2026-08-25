import pytest
from snowflake.connector.errors import DatabaseError, ProgrammingError

from snowflake.connector.network import ReauthenticationRequest

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


def test_run_query_passes_params_to_the_cursor():
    cur = FakeCursor(rows=[("EAST", 1.0)], description=[FakeCol("REGION"), FakeCol("T")])
    run_query(FakeConnection(cur), "SELECT ... WHERE x = ?", max_rows=10, params=["EAST"])
    assert cur.bound == [["EAST"]]


def test_run_query_without_params_binds_nothing():
    """Not `params=[]`: an empty sequence is a different call to the connector
    than no binding at all."""
    cur = FakeCursor(rows=[], description=[])
    run_query(FakeConnection(cur), "SELECT 1", max_rows=10)
    assert cur.bound == [None]


def test_map_oauth_access_token_expired_390318_is_auth_expired():
    # What an OAuth session raises once its access token has run out. It
    # used to fall through to QUERY_ERROR, so somebody whose app session was
    # perfectly good saw "Failed to load semantic views" instead of a
    # refreshed token.
    err = map_snowflake_error(
        ProgrammingError(msg="OAuth access token expired. [1234]", errno=390318)
    )
    assert isinstance(err, AuthExpiredError)
    assert err.status == 401


def test_map_oauth_access_token_invalid_390303_is_auth_expired():
    err = map_snowflake_error(
        ProgrammingError(msg="Invalid OAuth access token. [1234]", errno=390303)
    )
    assert isinstance(err, AuthExpiredError)


def test_map_token_expired_by_wording_when_the_errno_is_new():
    # A code this table has not met, saying the same thing.
    err = map_snowflake_error(
        DatabaseError(msg="Session token has expired. Please authenticate again.", errno=399999)
    )
    assert isinstance(err, AuthExpiredError)
    # ...but wording alone does not turn an ordinary failure into a sign-in.
    plain = map_snowflake_error(
        ProgrammingError(msg="SQL compilation error: invalid identifier 'X'", errno=904)
    )
    assert plain.code == "QUERY_ERROR"


def test_map_connectors_reauthentication_request_is_auth_expired():
    # The connector's own wrapper around a failed session renewal; not a
    # SnowflakeError itself, so it used to read as an unknown exception.
    cause = ProgrammingError(msg="Authentication token has expired.", errno=390114)
    err = map_snowflake_error(ReauthenticationRequest(cause))
    assert isinstance(err, AuthExpiredError)
