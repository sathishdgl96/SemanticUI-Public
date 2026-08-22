"""Who may certify a semantic view.

Snowflake decides, not the app. The caller's session has to hold the role
that owns the view, and every way of failing to establish that has to end in
a refusal -- a trust control that fails open is worse than no control, because
it produces a badge nobody checked.

Each refusal gets its own test because each is a *distinct* way to fail open,
and a single "returns False on bad input" test would let one of them regress
unnoticed.
"""

import uuid

import pytest

from app.db.models import ModelCertification, User
from app.semantic import certification
from tests.fakes import FakeCol, FakeConnection, FakeCursor

PERMITTED = [FakeCol("permitted")]


def answering(value) -> FakeConnection:
    return FakeConnection(FakeCursor(rows=[(value,)], description=PERMITTED))


def test_an_account_role_owner_is_asked_with_is_role_in_session():
    conn = answering(True)

    assert certification.may_certify(conn, "DATA_ENG", "ROLE") is True
    assert "IS_ROLE_IN_SESSION" in conn.cursor().executed[0]
    assert conn.cursor().bound[0] == ("DATA_ENG",)


def test_a_database_role_owner_is_asked_with_the_database_role_function():
    # IS_ROLE_IN_SESSION only answers for account roles. Asking it about a
    # database role would return FALSE for somebody who genuinely owns the
    # view -- a refusal, so it fails safe, but it makes certification
    # impossible on any account that owns its views this way.
    conn = answering(True)

    assert certification.may_certify(conn, "SALES.OWNER", "DATABASE_ROLE") is True
    assert "IS_DATABASE_ROLE_IN_SESSION" in conn.cursor().executed[0]


def test_snowflake_saying_no_is_a_refusal():
    assert certification.may_certify(answering(False), "DATA_ENG", "ROLE") is False


def test_a_null_answer_is_a_refusal():
    # Returned in shared objects reached through a data sharing consumer
    # account. NULL is "cannot tell", and cannot tell is no.
    assert certification.may_certify(answering(None), "DATA_ENG", "ROLE") is False


def test_an_unreadable_owner_is_a_refusal():
    # SHOW SEMANTIC VIEWS did not report one -- an older account, or TERSE.
    # There is nothing to ask Snowflake about, so nobody may certify.
    conn = answering(True)

    assert certification.may_certify(conn, None, "ROLE") is False
    assert conn.cursor().executed == []


def test_an_unrecognised_role_type_is_a_refusal():
    # Rather than guessing which function to call and getting a confident
    # answer to the wrong question.
    conn = answering(True)

    assert certification.may_certify(conn, "DATA_ENG", "APPLICATION_ROLE") is False
    assert conn.cursor().executed == []


def test_a_failing_check_is_a_refusal():
    conn = FakeConnection(
        FakeCursor(description=PERMITTED, error=RuntimeError("no warehouse"))
    )

    assert certification.may_certify(conn, "DATA_ENG", "ROLE") is False


def test_an_empty_answer_is_a_refusal():
    conn = FakeConnection(FakeCursor(rows=[], description=PERMITTED))

    assert certification.may_certify(conn, "DATA_ENG", "ROLE") is False


# --- The record ------------------------------------------------------------


@pytest.fixture
def user(db) -> User:
    row = User(id=uuid.uuid4(), snowflake_account="acct", snowflake_user="ada")
    db.add(row)
    db.commit()
    return row


def test_an_uncertified_view_has_no_record_rather_than_a_false_one(db):
    assert certification.get(db, "SALES", "PUBLIC", "V") is None


def test_certifying_records_the_role_whose_authority_was_used(db, user):
    certification.put(
        db, "SALES", "PUBLIC", "V", user=user, role="DATA_ENG",
        certified=True, owner_name="Revenue team", owner_contact="rev@x",
        note="quarter close",
    )

    row = certification.get(db, "SALES", "PUBLIC", "V")
    assert row.certified is True
    assert row.certified_by_role == "DATA_ENG"
    assert row.certified_by_user_id == user.id
    assert row.certified_at is not None


def test_clearing_certification_keeps_the_owner(db, user):
    # An uncertified model still has somebody to ask, and re-certifying
    # should not mean retyping what was already true.
    certification.put(
        db, "SALES", "PUBLIC", "V", user=user, role="DATA_ENG",
        certified=True, owner_name="Revenue team", owner_contact="rev@x",
        note="quarter close",
    )
    certification.put(
        db, "SALES", "PUBLIC", "V", user=user, role="DATA_ENG",
        certified=False, owner_name="Revenue team", owner_contact="rev@x",
        note=None,
    )

    row = certification.get(db, "SALES", "PUBLIC", "V")
    assert row.certified is False
    assert row.owner_name == "Revenue team"
    assert row.certified_at is None


def test_certifying_twice_updates_one_row(db, user):
    for note in ("first", "second"):
        certification.put(
            db, "SALES", "PUBLIC", "V", user=user, role="DATA_ENG",
            certified=True, owner_name="Revenue team", owner_contact=None,
            note=note,
        )

    rows = db.query(ModelCertification).all()
    assert len(rows) == 1
    assert rows[0].note == "second"


def test_certified_names_reads_a_whole_page_in_one_query(db, user):
    # The model picker shows a badge per row; it must not cost a query per row.
    for name in ("A", "B"):
        certification.put(
            db, "SALES", "PUBLIC", name, user=user, role="DATA_ENG",
            certified=True, owner_name=None, owner_contact=None, note=None,
        )
    certification.put(
        db, "SALES", "PUBLIC", "C", user=user, role="DATA_ENG",
        certified=False, owner_name=None, owner_contact=None, note=None,
    )

    certified = certification.certified_keys(db)

    assert ("SALES", "PUBLIC", "A") in certified
    assert ("SALES", "PUBLIC", "C") not in certified
