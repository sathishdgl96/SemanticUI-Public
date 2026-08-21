"""Composite models: one model over several semantic views.

Most of what is below checks one of two properties: joins are DECLARED
rather than inferred, and a composite holds a definition rather than
data -- so membership governs who may edit the mapping while Snowflake
still governs every number it produces.
"""

import pytest

from app.auth.sessions import SESSION_COOKIE, create_session
from app.composites import service
from app.composites.schema import MAX_MEMBERS, parse_definition
from app.db.models import CompositeModel, Workspace, WorkspaceMember
from app.errors import ApiError


def sign_in(client, db, user="ALICE"):
    sess = create_session(db, account="ACME", user=user, mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def workspace(db, user_id, name="Team", role="admin"):
    ws = Workspace(name=name, kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=role))
    db.commit()
    return ws


def member(alias, view, database="ANALYTICS", schema="PUBLIC"):
    return {"alias": alias, "database": database, "schema": schema, "view": view}


def definition(name="Customer 360", **over):
    doc = {
        "schemaVersion": 1,
        "name": name,
        "members": [member("sales", "SALES_SV"), member("support", "SUPPORT_SV")],
        "sharedDimensions": [
            {
                "name": "Customer",
                "bindings": {
                    "sales": {"table": "CUSTOMER", "column": "CUSTOMER_ID"},
                    "support": {"table": "CLIENT", "column": "CLIENT_ID"},
                },
            }
        ],
        "derivedMetrics": [],
        "joinType": "full",
        "crossFilter": "semi",
    }
    doc.update(over)
    return doc


# --------------------------------------------------------------- document


def test_a_blank_model_is_valid():
    # Creating one and filling it in later must be possible; a composite
    # that could not be saved empty could only be built in one sitting.
    from app.composites.schema import blank

    parsed = parse_definition(blank("Untitled model"))
    assert parsed.members == []
    assert parsed.joinType == "full"


def test_two_views_need_a_shared_dimension():
    # The rule that makes a composite answerable rather than merely
    # saveable: without a conformed dimension there is nothing to line
    # the two answers up on.
    with pytest.raises(ApiError) as caught:
        parse_definition(definition(sharedDimensions=[]))
    assert "shared" in str(caught.value.message).lower()


def test_one_view_needs_no_shared_dimension():
    parsed = parse_definition(
        definition(members=[member("sales", "SALES_SV")], sharedDimensions=[])
    )
    assert len(parsed.members) == 1


def test_aliases_must_be_unique_case_insensitively():
    # `sales` and `Sales` would make every field reference a coin toss.
    with pytest.raises(ApiError):
        parse_definition(
            definition(
                members=[member("sales", "A_SV"), member("Sales", "B_SV")],
                sharedDimensions=[],
            )
        )


def test_the_same_view_cannot_be_named_twice():
    with pytest.raises(ApiError) as caught:
        parse_definition(
            definition(
                members=[member("a", "SALES_SV"), member("b", "SALES_SV")],
                sharedDimensions=[],
            )
        )
    assert "twice" in str(caught.value.message)


def test_a_binding_must_name_a_member():
    with pytest.raises(ApiError) as caught:
        parse_definition(
            definition(
                sharedDimensions=[
                    {
                        "name": "Customer",
                        "bindings": {
                            "sales": {"table": "C", "column": "ID"},
                            "ghost": {"table": "C", "column": "ID"},
                        },
                    }
                ]
            )
        )
    assert "ghost" in str(caught.value.message)


def test_a_shared_dimension_needs_at_least_two_bindings():
    # A "shared" dimension present in one member is a local field.
    with pytest.raises(ApiError):
        parse_definition(
            definition(
                sharedDimensions=[
                    {
                        "name": "Customer",
                        "bindings": {"sales": {"table": "C", "column": "ID"}},
                    }
                ]
            )
        )


def test_a_label_without_a_key_is_refused():
    with pytest.raises(ApiError) as caught:
        parse_definition(
            definition(
                sharedDimensions=[
                    {
                        "name": "Customer",
                        "bindings": {
                            "sales": {"table": "CUSTOMER", "column": "CUSTOMER_ID"},
                            "support": {"table": "CLIENT", "column": "CLIENT_ID"},
                        },
                        "labels": {"ghost": {"table": "C", "column": "NAME"}},
                    }
                ]
            )
        )
    assert "ghost" in str(caught.value.message)


def test_a_derived_metric_resolves_its_members():
    parsed = parse_definition(
        definition(
            derivedMetrics=[
                {
                    "name": "Revenue per ticket",
                    "expr": {
                        "op": "/",
                        "left": {"metric": "sales:ORDERS.REVENUE"},
                        "right": {"metric": "support:TICKETS.TICKET_COUNT"},
                    },
                }
            ]
        )
    )
    assert parsed.derivedMetrics[0].nullIfDenominatorZero is True


def test_a_derived_metric_cannot_reference_an_unknown_member():
    with pytest.raises(ApiError) as caught:
        parse_definition(
            definition(
                derivedMetrics=[
                    {
                        "name": "Nonsense",
                        "expr": {
                            "op": "/",
                            "left": {"metric": "ghost:X.Y"},
                            "right": {"metric": "sales:ORDERS.REVENUE"},
                        },
                    }
                ]
            )
        )
    assert "ghost" in str(caught.value.message)


def test_an_unqualified_metric_reference_is_refused():
    # Guessing which member was meant is how a composite starts reporting
    # somebody else's numbers.
    with pytest.raises(ApiError) as caught:
        parse_definition(
            definition(
                derivedMetrics=[
                    {"name": "Bare", "expr": {"metric": "ORDERS.REVENUE"}}
                ]
            )
        )
    assert "alias:FIELD" in str(caught.value.message)


def test_a_derived_metric_of_only_constants_is_refused():
    with pytest.raises(ApiError) as caught:
        parse_definition(
            definition(
                derivedMetrics=[
                    {
                        "name": "Two",
                        "expr": {"op": "+", "left": {"value": 1}, "right": {"value": 1}},
                    }
                ]
            )
        )
    assert "constant" in str(caught.value.message).lower()


def test_an_expression_string_is_not_accepted():
    # The whole point of the AST: nothing a user types becomes SQL text.
    with pytest.raises(ApiError):
        parse_definition(
            definition(
                derivedMetrics=[
                    {"name": "Injected", "expr": "REVENUE / 0; DROP TABLE USERS"}
                ]
            )
        )


def test_members_are_capped():
    many = [member(f"m{i}", f"V{i}_SV") for i in range(MAX_MEMBERS + 1)]
    with pytest.raises(ApiError):
        parse_definition(definition(members=many, sharedDimensions=[]))


def test_an_unknown_key_is_refused_rather_than_ignored():
    with pytest.raises(ApiError):
        parse_definition(definition(joinStyle="outer"))


# ------------------------------------------------------------------ CRUD


def test_create_read_update_delete(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)

    created = client.post(
        "/api/composites", json={"name": "Customer 360", "workspaceId": str(ws.id)}
    )
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Customer 360"
    assert body["memberCount"] == 0
    composite_id = body["id"]

    saved = client.put(
        f"/api/composites/{composite_id}", json={"definition": definition()}
    )
    assert saved.status_code == 200
    assert saved.json()["memberCount"] == 2

    read = client.get(f"/api/composites/{composite_id}")
    assert read.status_code == 200
    assert read.json()["definition"]["sharedDimensions"][0]["name"] == "Customer"

    listed = client.get(f"/api/composites?workspace={ws.id}")
    assert [row["id"] for row in listed.json()["composites"]] == [composite_id]

    assert client.delete(f"/api/composites/{composite_id}").status_code == 204
    assert client.get(f"/api/composites/{composite_id}").status_code == 404


def test_the_document_round_trips_through_its_own_parser(client, db):
    # `schema` is a reserved-ish field name in the model; dumping without
    # by_alias would store `schema_` and make a saved model unopenable.
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})

    stored = client.get(f"/api/composites/{created['id']}").json()["definition"]
    assert stored["members"][0]["schema"] == "PUBLIC"
    # And it parses again, which is what "round trips" has to mean.
    parse_definition(stored)


def test_a_stranger_gets_404_not_403(client, db):
    owner = sign_in(client, db, "ALICE")
    ws = workspace(db, owner.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()

    sign_in(client, db, "MALLORY")
    # "Forbidden" would confirm the id exists.
    assert client.get(f"/api/composites/{created['id']}").status_code == 404
    assert client.put(
        f"/api/composites/{created['id']}", json={"definition": definition()}
    ).status_code == 404
    assert client.delete(f"/api/composites/{created['id']}").status_code == 404


def test_a_viewer_may_read_but_not_change(client, db):
    owner = sign_in(client, db, "ALICE")
    ws = workspace(db, owner.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()

    guest = sign_in(client, db, "BOB")
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=guest.user_id, role="viewer"))
    db.commit()

    assert client.get(f"/api/composites/{created['id']}").status_code == 200
    assert client.put(
        f"/api/composites/{created['id']}", json={"definition": definition()}
    ).status_code == 403


def test_listing_is_scoped_to_what_the_caller_is_a_member_of(client, db):
    alice = sign_in(client, db, "ALICE")
    mine = workspace(db, alice.user_id, name="Mine")
    client.post("/api/composites", json={"workspaceId": str(mine.id)})

    bob = sign_in(client, db, "BOB")
    theirs = workspace(db, bob.user_id, name="Theirs")
    client.post("/api/composites", json={"workspaceId": str(theirs.id)})

    # Bob sees his own and nothing of Alice's -- scoped in the query, so
    # a row he may not read never leaves the database.
    names = {row["workspaceName"] for row in client.get("/api/composites").json()["composites"]}
    assert names == {"Theirs"}


def test_an_invalid_definition_leaves_the_stored_one_alone(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})

    bad = client.put(
        f"/api/composites/{created['id']}",
        json={"definition": definition(sharedDimensions=[])},
    )
    assert bad.status_code == 400
    # A refused save must not half-apply.
    assert client.get(f"/api/composites/{created['id']}").json()["memberCount"] == 2


def test_creating_without_a_workspace_lands_in_the_personal_one(client, db):
    sign_in(client, db)
    created = client.post("/api/composites", json={"name": "Scratch"})
    assert created.status_code == 201
    assert created.json()["workspaceName"]


def test_deleting_forgets_favourites_and_recents(client, db):
    from app.library import state

    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    composite = db.get(CompositeModel, __import__("uuid").UUID(created["id"]))

    state.set_favorite(db, sess.user_id, "composite", composite.id, True)
    state.record_view(db, sess.user_id, "composite", composite.id)
    db.commit()

    service.delete_composite(db, sess.user_id, created["id"])
    # A favourite pointing at nothing is a link that always 404s.
    assert state.favorite_ids(db, sess.user_id, "composite") == set()
    assert state.recent_order(db, sess.user_id, "composite") == {}


def test_signed_out_callers_get_401(client, db):
    client.cookies.clear()
    assert client.get("/api/composites").status_code == 401
    assert client.post("/api/composites", json={}).status_code == 401


# ------------------------------------------------------- portability


def test_export_is_byte_stable_across_two_exports(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})

    first = client.get(f"/api/composites/{created['id']}/export")
    second = client.get(f"/api/composites/{created['id']}/export")
    assert first.status_code == 200
    assert first.text == second.text
    assert first.text.endswith("\n")


def test_an_exported_model_imports_back_to_the_same_thing(client, db):
    import json

    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})
    document = json.loads(client.get(f"/api/composites/{created['id']}/export").text)

    imported = client.post(
        "/api/composites/import",
        json={"definition": document, "workspaceId": str(ws.id)},
    )
    assert imported.status_code == 201
    assert imported.json()["name"] == "Customer 360"
    assert imported.json()["memberCount"] == 2
    # And the copy exports identically to its original.
    again = client.get(f"/api/composites/{imported.json()['id']}/export")
    assert json.loads(again.text) == document


def test_import_validates_exactly_as_a_save_does(client, db):
    # An import is a fast way to type a definition, not a way past the
    # rules.
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    refused = client.post(
        "/api/composites/import",
        json={
            "definition": definition(sharedDimensions=[]),
            "workspaceId": str(ws.id),
        },
    )
    assert refused.status_code == 400


def test_import_needs_write_access_to_the_target_workspace(client, db):
    owner = sign_in(client, db, "ALICE")
    ws = workspace(db, owner.user_id)

    guest = sign_in(client, db, "BOB")
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=guest.user_id, role="viewer"))
    db.commit()

    refused = client.post(
        "/api/composites/import",
        json={"definition": definition(), "workspaceId": str(ws.id)},
    )
    assert refused.status_code == 403


# --------------------------------------------------- filter value pickers


class _FakeResult:
    def __init__(self, rows):
        self.rows = rows
        self.columns = [{"name": "V", "type": "TEXT"}]
        self.truncated = False
        self.sfqid = "q1"


def _stub_snowflake(monkeypatch, rows, seen):
    """One member view answering a values query, recorded for inspection."""
    from app.composites import routes as composite_routes  # noqa: F401
    from app.semantic import routes as semantic_routes  # noqa: F401
    from app.snowflake import gateway, provider

    detail = {
        "tables": [{"name": "CUSTOMER"}, {"name": "CLIENT"}],
        "relationships": [],
        "dimensions": [
            {"table": "CUSTOMER", "name": "CUSTOMER_ID", "dataType": "TEXT"},
            {"table": "CUSTOMER", "name": "REGION", "dataType": "TEXT"},
            {"table": "CLIENT", "name": "CLIENT_ID", "dataType": "TEXT"},
        ],
        "metrics": [],
        "facts": [],
        "hierarchies": [],
    }

    class _Entry:
        conn = object()

        class lock:
            def __enter__(self):
                return None

            def __exit__(self, *a):
                return False

        lock = lock()

    class _Cache:
        def acquire(self, db, sess):
            return _Entry()

        def describe(self, entry, database, schema, view):
            seen.append(("describe", database, schema, view))
            return detail

    monkeypatch.setattr(provider, "get_cache", lambda: _Cache())
    monkeypatch.setattr(
        gateway,
        "run_query",
        lambda conn, sql, *, max_rows, params=None: (
            seen.append(("query", sql)) or _FakeResult(rows)
        ),
    )


def test_values_for_a_shared_dimension_come_from_one_member(client, db, monkeypatch):
    # A conformed dimension means the same thing in every member, so
    # asking the whole model would pay for a join to learn what one view
    # already knows.
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})

    seen: list = []
    _stub_snowflake(monkeypatch, [["ACME"], ["Globex"], [None]], seen)

    answer = client.get(
        f"/api/composites/{created['id']}/values",
        params={"field": "Customer 360.Customer"},
    )
    assert answer.status_code == 200
    # NULL is dropped: `IN (?)` never matches it, so offering it would
    # build a filter that silently returns nothing.
    assert answer.json()["values"] == ["ACME", "Globex"]
    # One view was asked, not both.
    assert [s for s in seen if s[0] == "query"].__len__() == 1


def test_values_for_a_members_own_field_go_to_that_member(client, db, monkeypatch):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})

    seen: list = []
    _stub_snowflake(monkeypatch, [["EU"]], seen)

    answer = client.get(
        f"/api/composites/{created['id']}/values",
        params={"field": "sales.CUSTOMER.REGION"},
    )
    assert answer.status_code == 200
    assert answer.json()["values"] == ["EU"]
    assert ("describe", "ANALYTICS", "PUBLIC", "SALES_SV") in seen


def test_a_derived_metric_has_no_values_to_pick_from(client, db, monkeypatch):
    # It is a number computed after the fact, not a column anybody filters
    # on -- and saying so beats an empty list nobody can explain.
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(
        f"/api/composites/{created['id']}",
        json={
            "definition": definition(
                derivedMetrics=[
                    {
                        "name": "Ratio",
                        "expr": {
                            "op": "/",
                            "left": {"metric": "sales:ORDERS.REVENUE"},
                            "right": {"metric": "support:TICKETS.TICKET_COUNT"},
                        },
                    }
                ]
            )
        },
    )
    refused = client.get(
        f"/api/composites/{created['id']}/values",
        params={"field": "Customer 360.Ratio"},
    )
    assert refused.status_code == 400
    assert "values" in refused.json()["message"].lower()


def test_values_for_an_unknown_field_are_refused(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})

    refused = client.get(
        f"/api/composites/{created['id']}/values", params={"field": "ghost.X.Y"}
    )
    assert refused.status_code == 400


# ------------------------------------------------------- the model's shape


def test_describe_returns_the_fields_and_each_members_graph(client, db, monkeypatch):
    """The canvas and the report builder both read this. It had no test,
    which is how a change to member_describes' signature could have
    emptied it in silence."""
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})

    seen: list = []
    _stub_snowflake(monkeypatch, [], seen)

    answer = client.get(f"/api/composites/{created['id']}/describe")
    assert answer.status_code == 200
    body = answer.json()

    # Fields, named so the client can map them back to the model.
    names = {(f["table"], f["name"]) for f in body["dimensions"]}
    assert ("Customer 360", "Customer") in names
    assert ("sales", "CUSTOMER.REGION") in names

    # And each member's own shape, which is what the designer draws as
    # tables and what the field list uses to grey unreachable pairs.
    graphs = {g["alias"]: g for g in body["memberGraphs"]}
    assert set(graphs) == {"sales", "support"}
    assert {t["name"] for t in graphs["sales"]["tables"]} == {"CUSTOMER", "CLIENT"}

    # Both members were described -- a member skipped in silence is a
    # container that renders with no tables in it.
    described = {s[3] for s in seen if s[0] == "describe"}
    assert described == {"SALES_SV", "SUPPORT_SV"}


def test_describe_still_answers_when_one_member_cannot_be_read(client, db, monkeypatch):
    # A model naming a view this caller may not see still exposes the
    # ones they may; Snowflake refuses the rest when a query asks.
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    created = client.post("/api/composites", json={"workspaceId": str(ws.id)}).json()
    client.put(f"/api/composites/{created['id']}", json={"definition": definition()})

    from app.snowflake import provider

    class _Entry:
        conn = object()

        class _Lock:
            def __enter__(self):
                return None

            def __exit__(self, *a):
                return False

        lock = _Lock()

    class _Cache:
        def acquire(self, db_, sess_):
            return _Entry()

        def describe(self, entry, database, schema, view):
            if view == "SUPPORT_SV":
                raise RuntimeError("not authorised")
            return {
                "tables": [{"name": "CUSTOMER"}],
                "relationships": [],
                "dimensions": [
                    {"table": "CUSTOMER", "name": "REGION", "dataType": "TEXT"}
                ],
                "metrics": [],
                "facts": [],
            }

    monkeypatch.setattr(provider, "get_cache", lambda: _Cache())

    body = client.get(f"/api/composites/{created['id']}/describe").json()
    assert [g["alias"] for g in body["memberGraphs"]] == ["sales"]
    assert any(f["table"] == "sales" for f in body["dimensions"])
