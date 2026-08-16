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

V2 = {
    **V1,
    "schemaVersion": 2,
    "visuals": [{**V1["visuals"][0], "filters": []}],
    "filters": [
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
    ],
    "hierarchies": [],
}


def test_v1_chains_through_to_v3():
    out = migrate_definition(V1)
    assert out["schemaVersion"] == SCHEMA_VERSION == 3
    assert "visuals" not in out
    assert out["filters"] == []
    assert out["hierarchies"] == []
    page = out["pages"][0]
    assert page["name"] == "Page 1"
    assert page["visuals"][0]["filters"] == []


def test_v2_becomes_v3_with_one_page():
    out = migrate_definition(V2)
    assert out["schemaVersion"] == 3
    assert "visuals" not in out
    page = out["pages"][0]
    assert page["id"] == "p1"
    assert page["name"] == "Page 1"
    assert page["visuals"] == V2["visuals"]
    # v2's top-level filters were labelled "Filters on this page" in the UI,
    # so they belong to the migrated page; the all-pages scope starts empty.
    assert page["filters"] == V2["filters"]
    assert out["filters"] == []


def test_migration_does_not_mutate_its_input():
    original = {**V1, "visuals": [dict(V1["visuals"][0])]}
    migrate_definition(original)
    assert original["schemaVersion"] == 1
    assert "filters" not in original
    assert "pages" not in original
    assert "filters" not in original["visuals"][0]


def test_v1_content_survives_untouched():
    out = migrate_definition(V1)
    assert out["name"] == "Sales overview"
    assert out["pages"][0]["visuals"][0]["wells"]["axis"] == ["CUSTOMERS.REGION"]


def test_a_v3_document_passes_through_unchanged():
    v3 = {
        "schemaVersion": 3,
        "name": "Sales overview",
        "view": V1["view"],
        "canvas": V1["canvas"],
        "pages": [{"id": "p1", "name": "Page 1", "visuals": [], "filters": []}],
        "filters": [],
        "hierarchies": [],
    }
    assert migrate_definition(v3) == v3


def test_claimed_v2_that_already_has_pages_passes_through_untouched():
    """Not a shape the migration understands; the validator names the problem."""
    weird = {"schemaVersion": 2, "pages": [{"id": "p1"}], "visuals": []}
    assert migrate_definition(weird) is weird


def test_a_future_version_is_left_alone_for_the_validator_to_reject():
    future = {**V1, "schemaVersion": 99}
    assert migrate_definition(future)["schemaVersion"] == 99


def test_a_non_dict_is_returned_as_is():
    assert migrate_definition("nope") == "nope"


def test_malformed_visuals_are_left_for_the_validator():
    out = migrate_definition({**V1, "visuals": "not-a-list"})
    assert "visuals" not in out
    assert out["pages"][0]["visuals"] == "not-a-list"


def test_a_non_dict_visual_is_left_for_the_validator():
    out = migrate_definition({**V1, "visuals": ["nope"]})
    assert out["pages"][0]["visuals"] == ["nope"]


def test_a_handwritten_v1_that_already_names_the_new_keys_keeps_them():
    """Upgrade, not overwrite: a document that already says what it wants is
    not second-guessed. Its filters were the page scope, so that is where
    they land."""
    handwritten = {
        **V1,
        "filters": [{"id": "f1", "field": "A.B", "op": "is", "values": ["X"]}],
    }
    out = migrate_definition(handwritten)
    assert out["pages"][0]["filters"] == handwritten["filters"]
    assert out["filters"] == []
