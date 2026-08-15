from app.reports.migrate import migrate_definition
from app.reports.schema import SCHEMA_VERSION

V1 = {
    "schemaVersion": 1,
    "name": "Sales overview",
    "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
    "canvas": {"columns": 12, "rowHeight": 40},
    "visuals": [
        {
            "id": "v1",
            "type": "bar",
            "title": "",
            "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
            "wells": {
                "axis": ["CUSTOMERS.REGION"],
                "legend": [],
                "values": ["ORDERS.TOTAL_REVENUE"],
            },
            "options": {},
        }
    ],
}


def test_v1_gains_the_v2_collections():
    out = migrate_definition(V1)
    assert out["schemaVersion"] == SCHEMA_VERSION == 2
    assert out["filters"] == []
    assert out["hierarchies"] == []
    assert out["visuals"][0]["filters"] == []


def test_migration_does_not_mutate_its_input():
    original = {**V1, "visuals": [dict(V1["visuals"][0])]}
    migrate_definition(original)
    assert original["schemaVersion"] == 1
    assert "filters" not in original
    assert "filters" not in original["visuals"][0]


def test_v1_content_survives_untouched():
    out = migrate_definition(V1)
    assert out["name"] == "Sales overview"
    assert out["visuals"][0]["wells"]["axis"] == ["CUSTOMERS.REGION"]


def test_a_v2_document_passes_through_unchanged():
    v2 = {
        **V1,
        "schemaVersion": 2,
        "filters": [
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
        ],
        "hierarchies": [],
    }
    assert migrate_definition(v2) == v2


def test_a_future_version_is_left_alone_for_the_validator_to_reject():
    future = {**V1, "schemaVersion": 99}
    assert migrate_definition(future)["schemaVersion"] == 99


def test_a_non_dict_is_returned_as_is():
    assert migrate_definition("nope") == "nope"


def test_malformed_visuals_are_left_for_the_validator():
    out = migrate_definition({**V1, "visuals": "not-a-list"})
    assert out["visuals"] == "not-a-list"


def test_a_non_dict_visual_is_left_for_the_validator():
    out = migrate_definition({**V1, "visuals": ["nope"]})
    assert out["visuals"] == ["nope"]


def test_a_handwritten_v1_that_already_names_the_new_keys_keeps_them():
    """Upgrade, not overwrite: a document that already says what it wants is
    not second-guessed."""
    handwritten = {
        **V1,
        "filters": [{"id": "f1", "field": "A.B", "op": "is", "values": ["X"]}],
    }
    out = migrate_definition(handwritten)
    assert out["filters"] == handwritten["filters"]
