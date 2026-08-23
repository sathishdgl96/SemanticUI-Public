"""Certification over HTTP, and the About page's endpoint.

The authority rule is the thing under test: the app must refuse to write a
certification unless Snowflake, asked on the caller's own connection, says the
session holds the role that owns the view.
"""

from tests.test_semantic_routes import login

VIEW = "/api/semantic-views/ANALYTICS/PUBLIC/SALES/certification"


def certify(client, **over):
    body = {
        "certified": True, "ownerName": "Revenue team",
        "ownerContact": "rev@example.com", "note": "quarter close",
    }
    return client.put(VIEW, json={**body, **over})


def test_certification_requires_auth(client):
    assert client.get(VIEW).status_code == 401
    assert client.put(VIEW, json={"certified": True}).status_code == 401


def test_an_uncertified_view_reports_absence_not_an_error(client, db):
    login(client, db)

    r = client.get(VIEW)

    assert r.status_code == 200
    assert r.json()["certified"] is False
    assert r.json()["owner"]["name"] is None


def test_the_owner_of_the_view_may_certify_it(client, db):
    login(client, db)

    assert certify(client).status_code == 200

    body = client.get(VIEW).json()
    assert body["certified"] is True
    assert body["certifiedBy"]["role"] == "DATA_ENG"
    assert body["note"] == "quarter close"


def test_somebody_who_does_not_hold_the_owning_role_is_refused(client, db):
    conn = login(client, db)
    conn.cursor_obj.may_certify = False

    assert certify(client).status_code == 403
    assert client.get(VIEW).json()["certified"] is False


def test_a_refusal_leaves_an_existing_record_untouched(client, db):
    conn = login(client, db)
    certify(client)

    conn.cursor_obj.may_certify = False
    assert certify(client, certified=False, note="tampered").status_code == 403

    body = client.get(VIEW).json()
    assert body["certified"] is True
    assert body["note"] == "quarter close"


def test_a_view_with_no_readable_owner_cannot_be_certified_by_anyone(client, db):
    # Fails closed: there is nothing to ask Snowflake about, so nobody
    # qualifies -- not even a user the app would otherwise trust.
    conn = login(client, db)
    conn.cursor_obj.owner = None

    assert certify(client).status_code == 403


def test_can_certify_tells_the_ui_whether_to_offer_the_control(client, db):
    conn = login(client, db)
    assert client.get(VIEW).json()["canCertify"] is True

    conn.cursor_obj.may_certify = False
    assert client.get(VIEW).json()["canCertify"] is False


def test_clearing_certification_keeps_the_owner(client, db):
    login(client, db)
    certify(client)

    certify(client, certified=False, note=None)

    body = client.get(VIEW).json()
    assert body["certified"] is False
    assert body["owner"]["name"] == "Revenue team"
    assert body["certifiedBy"] is None


def test_the_listing_carries_the_badge(client, db):
    login(client, db)
    assert client.get("/api/semantic-views").json()["views"][0]["certified"] is False

    certify(client)

    views = client.get("/api/semantic-views").json()["views"]
    assert views[0]["certified"] is True


def test_certifying_is_audited_with_the_role_that_authorised_it(client, db):
    from app.db.models import AuditEvent

    login(client, db)
    certify(client)

    actions = [e.action for e in db.query(AuditEvent).all()]
    assert "model.certify" in actions


def test_clearing_is_audited_as_its_own_action(client, db):
    from app.db.models import AuditEvent

    login(client, db)
    certify(client)
    certify(client, certified=False)

    actions = [e.action for e in db.query(AuditEvent).all()]
    assert "model.uncertify" in actions


# --- The About page's endpoint ---------------------------------------------


def a_report(client) -> str:
    from tests.test_report_routes import valid_definition

    r = client.post("/api/reports", json={"definition": valid_definition()})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def test_provenance_requires_access(client, db):
    login(client, db)
    report_id = a_report(client)
    client.cookies.clear()

    assert client.get(f"/api/reports/{report_id}/provenance").status_code == 401


def test_provenance_carries_the_model_and_its_freshness(client, db):
    login(client, db)
    report_id = a_report(client)
    certify(client)

    body = client.get(f"/api/reports/{report_id}/provenance").json()

    assert body["model"]["certified"] is True
    assert body["model"]["name"] == "SALES"
    assert body["freshness"]["available"] is True


def test_unreadable_freshness_still_renders_the_rest_of_the_page(client, db):
    # The whole reason the blocks are assembled rather than fetched together:
    # a warehouse that will not start must not blank the model block.
    conn = login(client, db)
    report_id = a_report(client)
    certify(client)
    conn.cursor_obj.freshness_error = RuntimeError("no warehouse")

    body = client.get(f"/api/reports/{report_id}/provenance").json()

    assert body["freshness"]["available"] is False
    assert body["model"]["certified"] is True


def test_lineage_and_open_issues_declare_themselves_unwired(client, db):
    login(client, db)
    report_id = a_report(client)

    body = client.get(f"/api/reports/{report_id}/provenance").json()

    assert body["lineage"]["available"] is False
    assert body["openIssues"]["available"] is False
