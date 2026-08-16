import pytest
from snowflake.connector.errors import ProgrammingError

from app.cortex.provider import (
    CORTEX_UNAVAILABLE_ERRNO,
    CortexProvider,
    FakeProvider,
)
from app.errors import ApiError
from tests.fakes import FakeConnection, FakeCursor


def test_the_prompt_is_sent_as_a_bound_parameter():
    """The prompt embeds a user's question. Interpolating it into the SQL would
    make a question containing a quote a syntax error at best."""
    cur = FakeCursor(rows=[("a reply",)])
    CortexProvider("llama3.1-70b").complete(FakeConnection(cur), "how much revenue?")
    assert cur.bound == [["llama3.1-70b", "how much revenue?"]]
    assert "how much revenue?" not in cur.executed[0]


def test_the_configured_model_is_used():
    cur = FakeCursor(rows=[("x",)])
    CortexProvider("mistral-large2").complete(FakeConnection(cur), "q")
    assert cur.bound[0][0] == "mistral-large2"


def test_the_reply_is_returned_verbatim():
    cur = FakeCursor(rows=[('{"metrics": []}',)])
    assert CortexProvider("m").complete(FakeConnection(cur), "q") == '{"metrics": []}'


def test_an_empty_reply_is_an_error_not_an_empty_string():
    """A silent empty string would surface later as unparseable JSON, blaming
    the wrong layer for the failure."""
    cur = FakeCursor(rows=[])
    with pytest.raises(ApiError) as exc:
        CortexProvider("m").complete(FakeConnection(cur), "q")
    assert exc.value.code == "ASK_FAILED"


def test_a_trial_account_reports_cortex_unavailable_with_snowflakes_own_message():
    """The user is told WHY, not shown a generic failure. This is the state of
    the development account, so it is the path most likely to be hit."""
    cur = FakeCursor(
        error=ProgrammingError(
            msg="AI function COMPLETE is not available for trial accounts.",
            errno=CORTEX_UNAVAILABLE_ERRNO,
        )
    )
    with pytest.raises(ApiError) as exc:
        CortexProvider("m").complete(FakeConnection(cur), "q")
    assert exc.value.code == "CORTEX_UNAVAILABLE"
    assert exc.value.status == 503
    assert "trial accounts" in exc.value.message


def test_unavailability_is_also_detected_from_the_message_alone():
    """The errno is the primary signal; the text is checked too, in case the
    code changes."""
    cur = FakeCursor(
        error=ProgrammingError(
            msg="AI function COMPLETE is not available for trial accounts.",
            errno=1,
        )
    )
    with pytest.raises(ApiError) as exc:
        CortexProvider("m").complete(FakeConnection(cur), "q")
    assert exc.value.code == "CORTEX_UNAVAILABLE"


def test_any_other_snowflake_error_is_a_plain_ask_failure():
    cur = FakeCursor(error=ProgrammingError(msg="warehouse suspended", errno=606))
    with pytest.raises(ApiError) as exc:
        CortexProvider("m").complete(FakeConnection(cur), "q")
    assert exc.value.code == "ASK_FAILED"
    assert "warehouse suspended" in exc.value.message


def test_the_cursor_is_closed_even_when_the_call_fails():
    """A leaked cursor per failed question would be a slow leak on the path
    that, on this account, fires every single time."""
    closed = []

    class TrackingCursor(FakeCursor):
        def close(self):
            closed.append(True)

    cur = TrackingCursor(error=ProgrammingError(msg="nope", errno=1))
    with pytest.raises(ApiError):
        CortexProvider("m").complete(FakeConnection(cur), "q")
    assert closed == [True]


class TestFakeProvider:
    """The fake is what every other test in this sub-project runs on, so its
    own behaviour is worth pinning."""

    def test_it_returns_the_configured_reply(self):
        assert FakeProvider(reply="hello").complete(None, "q") == "hello"

    def test_it_records_the_prompt_it_was_given(self):
        provider = FakeProvider(reply="x")
        provider.complete(None, "the prompt")
        assert provider.prompts == ["the prompt"]

    def test_it_can_raise_instead(self):
        boom = ApiError("CORTEX_UNAVAILABLE", 503, "nope")
        with pytest.raises(ApiError):
            FakeProvider(error=boom).complete(None, "q")

    def test_it_records_the_prompt_even_when_it_raises(self):
        provider = FakeProvider(error=ApiError("ASK_FAILED", 502, "x"))
        with pytest.raises(ApiError):
            provider.complete(None, "the prompt")
        assert provider.prompts == ["the prompt"]
