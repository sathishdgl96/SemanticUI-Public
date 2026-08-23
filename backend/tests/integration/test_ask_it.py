"""Asking a real question of the real account.

The end-to-end test SKIPS while Cortex is unavailable, which it is on this
trial account (errno 399258). A skip is not a pass, and this file exists partly
to make the gap visible in the test output rather than leaving it silent.
"""

import os

import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("SEMANTICUI_IT_ACCOUNT"),
        reason="SEMANTICUI_IT_* env vars not set",
    ),
]


def _connect():
    from app.snowflake import connect as sf_connect

    return sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
    )


def test_cortex_availability_is_recorded():
    """Never fails. Records what the account actually offers, so the reason the
    feature is dark is evidence rather than memory.

    Run with -s to see it.
    """
    conn = _connect()
    try:
        cur = conn.cursor()
        try:
            cur.execute(
                "SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?)", ["llama3.1-70b", "hi"]
            )
            print(f"\n[cortex] AVAILABLE: {cur.fetchone()}")
        except Exception as exc:
            errno = getattr(exc, "errno", None)
            print(f"\n[cortex] UNAVAILABLE: errno={errno} {str(exc)[:200]}")
        finally:
            cur.close()
    finally:
        conn.close()


@pytest.mark.skipif(
    os.environ.get("SEMANTICUI_IT_CORTEX") != "1",
    reason="set SEMANTICUI_IT_CORTEX=1 once the account has Cortex provisioned",
)
def test_a_real_question_returns_a_spec_the_catalog_accepts():
    """The end-to-end path against a real model.

    Opt-in, because it cannot run until Cortex is provisioned. When it can, it
    proves the part the FakeProvider cannot: that a real model, given this
    prompt, answers with something the catalog validation accepts.
    """
    from app.cortex.prompt import build_prompt
    from app.cortex.provider import CortexProvider
    from app.cortex.spec import parse_spec, validate_against_catalog
    from app.semantic.discovery import describe_semantic_view

    conn = _connect()
    try:
        detail = describe_semantic_view(
            conn,
            os.environ["SEMANTICUI_IT_DATABASE"],
            os.environ["SEMANTICUI_IT_SCHEMA"],
            os.environ["SEMANTICUI_IT_VIEW"],
        )
        prompt = build_prompt(detail, "How many customers are there?")
        reply = CortexProvider("llama3.1-70b").complete(conn, prompt)
        print(f"\n[cortex] reply: {reply[:400]}")
        spec = parse_spec(reply)
        validate_against_catalog(spec, detail)
        assert spec.metrics or spec.dimensions
    finally:
        conn.close()
