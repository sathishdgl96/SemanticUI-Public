"""Saved explores: a saved QUERY, governed by the same workspace rules as a
report."""

import pytest
from sqlalchemy import select

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import SavedExplore, Workspace, WorkspaceMember
from app.errors import ApiError
from app.explores.schema import (
    MAX_DEFINITION_BYTES,
    MAX_FIELDS,
    SCHEMA_VERSION,
    parse_definition,
    to_export_document,
)


def valid_doc(**overrides):
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "name": "Revenue by region",
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "dimensions": ["CUSTOMERS.REGION"],
        "metrics": ["ORDERS.REVENUE"],
        "filters": [],
        "orderBy": [],
    }
    doc.update(overrides)
    return doc


def sign_in(client, db, user="ALICE"):
    sess = create_session(db, account="ACME", user=user, mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


# --- the document ----------------------------------------------------------


def test_parses_a_valid_explore():
    d = parse_definition(valid_doc())
    assert d.name == "Revenue by region"
    assert d.dimensions == ["CUSTOMERS.REGION"]
    assert d.metrics == ["ORDERS.REVENUE"]


def test_rejects_an_unknown_key():
    with pytest.raises(ApiError):
        parse_definition(valid_doc(surprise="x"))


def test_rejects_an_unsupported_version():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(schemaVersion=99))
    assert "schemaVersion" in exc.value.message


def test_an_explore_must_name_a_view():
    """Unlike a report, an explore IS a query: unbound it cannot be reopened."""
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(view={"database": "", "schema": "", "name": ""}))
    assert "semantic view" in exc.value.message.lower()


def test_an_explore_must_select_something():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(dimensions=[], metrics=[]))
    assert "at least one field" in exc.value.message


def test_a_field_may_not_be_selected_twice():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(dimensions=["C.REGION", "c.region"]))
    assert "more than once" in exc.value.message


def test_duplicate_filter_ids_are_rejected():
    f = {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(filters=[f, dict(f)]))
    assert "f1" in exc.value.message


def test_ordering_by_an_unselected_field_is_rejected():
    """Caught here so a saved explore always reopens, rather than failing at
    query time whenever someone happens to run it."""
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(orderBy=[{"field": "ORDERS.GHOST"}]))
    assert "not selected" in exc.value.message


def test_ordering_by_a_selected_field_is_allowed():
    d = parse_definition(
        valid_doc(orderBy=[{"field": "ORDERS.REVENUE", "direction": "desc"}])
    )
    assert d.orderBy[0].direction == "desc"


def test_an_unknown_direction_is_rejected():
    with pytest.raises(ApiError):
        parse_definition(
            valid_doc(orderBy=[{"field": "ORDERS.REVENUE", "direction": "sideways"}])
        )


def test_too_many_fields_are_rejected():
    with pytest.raises(ApiError):
        parse_definition(
            valid_doc(dimensions=[f"C.F{i}" for i in range(MAX_FIELDS + 1)])
        )


def test_an_oversized_document_is_rejected():
    """Built from individually-legal refs, so only the shared byte cap can
    reject it -- the size check runs before pydantic for exactly this
    reason."""
    pad = "X" * 480
    with pytest.raises(ApiError) as exc:
        parse_definition(
            valid_doc(
                dimensions=[f"C.{pad}_{i:02d}" for i in range(MAX_FIELDS)],
                metrics=[f"M.{pad}_{i:02d}" for i in range(MAX_FIELDS)],
            )
        )
    assert exc.value.code == "EXPLORE_INVALID"
    assert str(MAX_DEFINITION_BYTES) in exc.value.message


def test_the_filter_vocabulary_is_the_report_one():
    """One filter language across the product, not one per surface."""
    d = parse_definition(
        valid_doc(
            filters=[
                {"id": "a", "field": "CUSTOMERS.REGION", "op": "contains", "value": "E"},
                {"id": "b", "field": "ORDERS.TOTAL", "op": "gte", "value": 5},
                {"id": "c", "field": "CUSTOMERS.SEGMENT", "op": "isBlank"},
            ]
        )
    )
    assert [f.op for f in d.filters] == ["contains", "gte", "isBlank"]


def test_export_is_deterministic_and_sorted():
    a = to_export_document(parse_definition(valid_doc()))
    b = to_export_document(parse_definition(valid_doc()))
    assert a == b
    assert a.endswith("\n")


# --- the routes ------------------------------------------------------------


def test_explores_require_authentication(client):
    assert client.get("/api/explores").status_code == 401
    assert (
        client.post("/api/explores", json={"definition": valid_doc()}).status_code == 401
    )


def test_create_list_get_update_delete(client, db):
    sign_in(client, db)

    created = client.post("/api/explores", json={"definition": valid_doc()})
    assert created.status_code == 201, created.json()
    explore_id = created.json()["id"]
    assert created.json()["name"] == "Revenue by region"
    assert created.json()["view"]["name"] == "SALES"

    listing = client.get("/api/explores")
    assert [e["id"] for e in listing.json()["explores"]] == [explore_id]
    # The list is a summary: the document itself is fetched per explore.
    assert "definition" not in listing.json()["explores"][0]

    detail = client.get(f"/api/explores/{explore_id}")
    assert detail.json()["definition"]["dimensions"] == ["CUSTOMERS.REGION"]

    renamed = valid_doc(name="Renamed")
    assert (
        client.put(
            f"/api/explores/{explore_id}", json={"definition": renamed}
        ).status_code
        == 200
    )
    assert client.get(f"/api/explores/{explore_id}").json()["name"] == "Renamed"

    assert client.delete(f"/api/explores/{explore_id}").status_code == 204
    assert client.get(f"/api/explores/{explore_id}").status_code == 404


def test_an_invalid_definition_is_rejected(client, db):
    sign_in(client, db)
    response = client.post(
        "/api/explores", json={"definition": valid_doc(dimensions=[], metrics=[])}
    )
    assert response.status_code == 400
    assert response.json()["code"] == "EXPLORE_INVALID"


def test_a_new_explore_lands_in_my_personal_workspace(client, db):
    sess = sign_in(client, db)
    created = client.post("/api/explores", json={"definition": valid_doc()}).json()
    personal = (
        db.query(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == sess.user_id, Workspace.kind == "personal")
        .one()
    )
    assert created["workspaceId"] == str(personal.id)
    assert created["myRole"] == "admin"


def _shared_workspace(db, user_id, name="Team", role="editor"):
    ws = Workspace(name=name, kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=role))
    db.commit()
    return ws


def test_someone_elses_explore_is_404_on_every_verb(client, db):
    """404 and not 403: a stranger must not learn that this id exists."""
    sign_in(client, db, user="ALICE")
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs_ws = _shared_workspace(db, other.user_id, "Theirs", role="admin")
    theirs = SavedExplore(
        owner_user_id=other.user_id,
        workspace_id=theirs_ws.id,
        name="Theirs",
        view_database="A", view_schema="B", view_name="C",
        definition=valid_doc(),
    )
    db.add(theirs)
    db.commit()

    assert client.get(f"/api/explores/{theirs.id}").status_code == 404
    assert client.get(f"/api/explores/{theirs.id}/export").status_code == 404
    assert (
        client.put(
            f"/api/explores/{theirs.id}", json={"definition": valid_doc()}
        ).status_code
        == 404
    )
    assert client.delete(f"/api/explores/{theirs.id}").status_code == 404
    assert client.get("/api/explores").json()["explores"] == []


def test_a_viewer_may_read_but_not_write(client, db):
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="viewer")
    explore = SavedExplore(
        owner_user_id=sess.user_id,
        workspace_id=ws.id,
        name="Shared",
        view_database="A", view_schema="B", view_name="C",
        definition=valid_doc(),
    )
    db.add(explore)
    db.commit()

    assert client.get(f"/api/explores/{explore.id}").status_code == 200
    write = client.put(
        f"/api/explores/{explore.id}", json={"definition": valid_doc()}
    )
    assert write.status_code == 403
    assert write.json()["code"] == "WORKSPACE_FORBIDDEN"
    assert client.delete(f"/api/explores/{explore.id}").status_code == 403


def test_creating_in_a_workspace_i_can_only_read_is_403(client, db):
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="viewer")
    response = client.post(
        "/api/explores",
        json={"definition": valid_doc(), "workspaceId": str(ws.id)},
    )
    assert response.status_code == 403


def test_listing_can_be_scoped_to_one_workspace(client, db):
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="editor")
    client.post(
        "/api/explores",
        json={"definition": valid_doc(name="In the team ws"), "workspaceId": str(ws.id)},
    )
    client.post("/api/explores", json={"definition": valid_doc(name="Mine")})

    scoped = client.get("/api/explores", params={"workspace": str(ws.id)}).json()
    assert [e["name"] for e in scoped["explores"]] == ["In the team ws"]


def test_scoping_to_a_workspace_i_do_not_belong_to_is_404(client, db):
    sign_in(client, db)
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs = _shared_workspace(db, other.user_id, "Theirs", role="admin")
    assert (
        client.get("/api/explores", params={"workspace": str(theirs.id)}).status_code
        == 404
    )


def test_the_row_stores_the_document_and_nothing_else(client, db):
    sign_in(client, db)
    client.post("/api/explores", json={"definition": valid_doc()})
    row = db.scalars(select(SavedExplore)).one()
    assert set(row.definition) == {
        "schemaVersion", "name", "view", "dimensions", "metrics",
        "filters", "orderBy", "limit",
    }


def test_export_carries_no_identity(client, db):
    sign_in(client, db)
    explore_id = client.post(
        "/api/explores", json={"definition": valid_doc()}
    ).json()["id"]
    first = client.get(f"/api/explores/{explore_id}/export")
    assert first.status_code == 200
    assert first.text == client.get(f"/api/explores/{explore_id}/export").text
    for leaked in ("ALICE", "ACME", "owner", "createdAt", "updatedAt"):
        assert leaked not in first.text
    assert explore_id not in first.text
