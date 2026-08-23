"""The four blocks of a report's About page.

Assembly only: this module holds no SQL and asks Snowflake nothing. What it
must get right is that each block fails on its own -- a model can be certified
while its freshness is unreadable, and the page has to render either way.
"""

from datetime import datetime, timezone

from app.db.models import ModelCertification
from app.reports import provenance

VIEW = {"database": "SALES", "schema": "PUBLIC", "name": "REVENUE"}
AT = datetime(2026, 8, 22, 6, 15, tzinfo=timezone.utc)
FRESH = {"tables": [], "oldest": AT, "complete": True, "available": True}


def certified_row() -> ModelCertification:
    return ModelCertification(
        database="SALES", schema="PUBLIC", name="REVENUE", certified=True,
        certified_by_role="DATA_ENG", certified_at=AT,
        owner_name="Revenue team", owner_contact="rev@example.com",
        note="quarter close",
    )


def test_an_uncertified_model_says_so_rather_than_going_quiet():
    block = provenance.build(view=VIEW, record=None, freshness=FRESH)["model"]

    assert block["certified"] is False
    assert block["owner"]["name"] is None
    # Absence is the answer here, not a missing one.
    assert block["certifiedBy"] is None


def test_a_certified_model_names_the_role_that_vouched_for_it():
    block = provenance.build(
        view=VIEW, record=certified_row(), freshness=FRESH
    )["model"]

    assert block["certified"] is True
    assert block["certifiedBy"]["role"] == "DATA_ENG"
    assert block["owner"]["name"] == "Revenue team"
    assert block["note"] == "quarter close"


def test_an_owner_survives_certification_being_cleared():
    row = certified_row()
    row.certified = False
    row.certified_at = None

    block = provenance.build(view=VIEW, record=row, freshness=FRESH)["model"]

    assert block["certified"] is False
    assert block["owner"]["name"] == "Revenue team"
    assert block["certifiedBy"] is None


def test_freshness_travels_through_untouched():
    block = provenance.build(view=VIEW, record=None, freshness=FRESH)

    assert block["freshness"] == FRESH


def test_unreadable_freshness_does_not_take_the_model_block_with_it():
    dead = {"tables": [], "oldest": None, "complete": False, "available": False}

    block = provenance.build(view=VIEW, record=certified_row(), freshness=dead)

    assert block["freshness"]["available"] is False
    assert block["model"]["certified"] is True


def test_lineage_and_open_issues_are_declared_placeholders_not_silence():
    # Both render with their real shape and say they are not wired yet. A
    # block that simply returned nothing would be indistinguishable from a
    # model with no lineage and no problems, which is the wrong claim.
    built = provenance.build(view=VIEW, record=None, freshness=FRESH)

    assert built["lineage"]["available"] is False
    assert built["lineage"]["placeholder"]
    assert built["openIssues"]["available"] is False
    assert built["openIssues"]["columns"]
    assert built["openIssues"]["issues"] == []
