import json

import pytest

from app.errors import ApiError
from app.reports.schema import (
    MAX_DEFINITION_BYTES,
    MAX_REF_LENGTH,
    MAX_REFS_PER_WELL,
    MAX_VISUALS,
    SCHEMA_VERSION,
    parse_definition,
    to_export_document,
)
from tests.test_report_routes import oversized_definition


def valid_doc(**overrides):
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "name": "Sales overview",
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": [
            {
                "id": "v1",
                "type": "bar",
                "title": "Revenue by region",
                "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                "wells": {"axis": ["C.REGION"], "legend": [], "values": ["A.REV"]},
                "options": {"stacked": False},
            }
        ],
    }
    doc.update(overrides)
    return doc


def test_parses_a_valid_document():
    d = parse_definition(valid_doc())
    assert d.name == "Sales overview"
    assert d.view.name == "SALES"
    assert d.visuals[0].type == "bar"
    assert d.visuals[0].layout.w == 6


def test_rejects_an_unsupported_schema_version():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(schemaVersion=99))
    assert exc.value.code == "REPORT_INVALID"
    assert "schemaVersion" in exc.value.message


def test_rejects_unknown_top_level_and_visual_keys():
    with pytest.raises(ApiError):
        parse_definition(valid_doc(surpriseKey="x"))
    doc = valid_doc()
    doc["visuals"][0]["surprise"] = 1
    with pytest.raises(ApiError):
        parse_definition(doc)


def test_rejects_an_unknown_visual_type():
    doc = valid_doc()
    doc["visuals"][0]["type"] = "hologram"
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "hologram" in exc.value.message


def test_rejects_well_cardinality_violations():
    doc = valid_doc()
    doc["visuals"][0]["wells"] = {"axis": [], "legend": [], "values": ["A.REV"]}
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "Axis" in exc.value.message


def test_rejects_unknown_option_keys():
    doc = valid_doc()
    doc["visuals"][0]["options"] = {"stacked": False, "rainbow": True}
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "rainbow" in exc.value.message


def test_rejects_duplicate_visual_ids():
    doc = valid_doc()
    doc["visuals"].append(dict(doc["visuals"][0]))
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "duplicate" in exc.value.message.lower()


def test_rejects_too_many_visuals():
    doc = valid_doc()
    base = doc["visuals"][0]
    doc["visuals"] = [dict(base, id=f"v{i}") for i in range(MAX_VISUALS + 1)]
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert str(MAX_VISUALS) in exc.value.message


def test_rejects_a_well_with_too_many_refs():
    doc = valid_doc()
    doc["visuals"][0]["wells"]["values"] = [
        f"A.M{i}" for i in range(MAX_REFS_PER_WELL + 1)
    ]
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert exc.value.code == "REPORT_INVALID"


def test_rejects_an_overlong_well_ref():
    doc = valid_doc()
    doc["visuals"][0]["wells"]["axis"] = ["C." + "R" * MAX_REF_LENGTH]
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert exc.value.code == "REPORT_INVALID"


def test_rejects_an_oversized_document_even_when_every_field_is_individually_legal():
    with pytest.raises(ApiError) as exc:
        parse_definition(oversized_definition())
    assert exc.value.code == "REPORT_INVALID"
    assert exc.value.message == (
        f"The definition exceeds the {MAX_DEFINITION_BYTES} byte limit"
    )


def test_export_document_is_deterministic_and_sorted():
    a = to_export_document(parse_definition(valid_doc()))
    b = to_export_document(parse_definition(valid_doc()))
    assert a == b
    parsed = json.loads(a)
    assert list(parsed) == sorted(parsed)
    # No identity, timestamps or ids leak into the portable document.
    assert "owner" not in a and "createdAt" not in a and "updatedAt" not in a
    assert a.endswith("\n")


def test_an_unbound_definition_with_no_visuals_parses():
    # A brand-new report isn't attached to a semantic view yet -- that's a
    # legitimate starting state as long as it holds no visuals.
    doc = valid_doc(
        view={"database": "", "schema": "", "name": ""},
        visuals=[],
    )
    d = parse_definition(doc)
    assert d.view.database == ""
    assert d.view.schema_ == ""
    assert d.view.name == ""
    assert d.visuals == []


def test_an_unbound_definition_with_a_visual_is_rejected():
    # A visual's fields have to come from somewhere -- an empty view can't
    # back a visual, so this must fail even though each field individually
    # (empty string) is now allowed by the schema.
    doc = valid_doc(view={"database": "", "schema": "", "name": ""})
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert exc.value.code == "REPORT_INVALID"
    assert "semantic view" in exc.value.message.lower()


def test_a_bound_definition_with_visuals_still_parses():
    d = parse_definition(valid_doc())
    assert d.view.name == "SALES"
    assert len(d.visuals) == 1


def test_validation_errors_do_not_echo_the_submitted_value():
    marker = "SENSITIVE-MARKER-VALUE"
    doc = valid_doc()
    doc["visuals"][0]["layout"] = {"x": marker, "y": 0, "w": 6, "h": 6}
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert marker not in str(exc.value.detail or "")
    # message is a static string, never derived from input; assert the
    # real invariant rather than a trivially-true absence check.
    assert exc.value.message == "The report definition is not valid"
    # The path and reason must survive — the point is redaction, not silence.
    assert "layout" in str(exc.value.detail)
    assert "int_parsing" in str(exc.value.detail)
    assert "valid integer" in str(exc.value.detail)


# --- v2: filters, hierarchies and the v1 migration -------------------------


def _bar(**overrides) -> dict:
    base = {
        "id": "v1",
        "type": "bar",
        "title": "",
        "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
        "wells": {"axis": ["CUSTOMERS.REGION"], "legend": [], "values": ["ORDERS.TOTAL"]},
        "options": {},
        "filters": [],
    }
    return {**base, **overrides}


def test_a_v1_document_still_parses_through_the_migration():
    """Reports saved before this branch must keep opening, forever."""
    v1 = {
        "schemaVersion": 1,
        "name": "R",
        "view": {"database": "D", "schema": "S", "name": "V"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": [],
    }
    definition = parse_definition(v1)
    assert definition.schemaVersion == SCHEMA_VERSION == 2
    assert definition.filters == []
    assert definition.hierarchies == []


def test_a_version_above_the_current_one_is_still_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(schemaVersion=99))
    assert "99" in exc.value.message


def test_report_scope_filters_parse():
    definition = parse_definition(
        valid_doc(filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
        ])
    )
    assert definition.filters[0].field == "CUSTOMERS.REGION"


def test_visual_scope_filters_parse():
    definition = parse_definition(
        valid_doc(visuals=[_bar(filters=[
            {"id": "f2", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
             "unit": "day", "count": 30}
        ])])
    )
    assert definition.visuals[0].filters[0].op == "relativeDate"


def test_an_unknown_operator_is_report_invalid():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "regex", "values": [".*"]}
        ]))
    assert exc.value.code == "REPORT_INVALID"


def test_duplicate_filter_ids_are_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]},
            {"id": "f1", "field": "CUSTOMERS.COUNTRY", "op": "is", "values": ["US"]},
        ]))
    assert "f1" in exc.value.message


def test_the_same_filter_id_may_appear_in_two_different_scopes():
    """Scopes are addressed separately, so an id only has to be unique within
    one of them -- report "f1" and a visual's "f1" never collide."""
    definition = parse_definition(valid_doc(
        filters=[{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}],
        visuals=[_bar(filters=[
            {"id": "f1", "field": "ORDERS.CHANNEL", "op": "is", "values": ["WEB"]}
        ])],
    ))
    assert definition.filters[0].id == definition.visuals[0].filters[0].id == "f1"


def test_a_hierarchy_parses():
    definition = parse_definition(valid_doc(hierarchies=[
        {"id": "h1", "name": "Geography",
         "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"]}
    ]))
    assert definition.hierarchies[0].levels[2] == "CUSTOMERS.CITY"


def test_a_one_level_hierarchy_is_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(hierarchies=[
            {"id": "h1", "name": "Geography", "levels": ["CUSTOMERS.COUNTRY"]}
        ]))
    assert "two levels" in exc.value.message


def test_duplicate_levels_within_one_hierarchy_are_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(hierarchies=[
            {"id": "h1", "name": "Geo",
             "levels": ["CUSTOMERS.COUNTRY", "customers.country"]}
        ]))
    assert "more than once" in exc.value.message


def test_duplicate_hierarchy_ids_are_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(hierarchies=[
            {"id": "h1", "name": "A", "levels": ["C.X", "C.Y"]},
            {"id": "h1", "name": "B", "levels": ["C.P", "C.Q"]},
        ]))
    assert "h1" in exc.value.message


def test_a_well_may_reference_a_declared_hierarchy():
    definition = parse_definition(valid_doc(
        hierarchies=[{"id": "h1", "name": "Geo",
                      "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE"]}],
        visuals=[_bar(wells={"axis": ["hierarchy:h1"], "legend": [],
                             "values": ["ORDERS.TOTAL"]})],
    ))
    assert definition.visuals[0].wells["axis"] == ["hierarchy:h1"]


def test_a_well_referencing_an_undeclared_hierarchy_is_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(visuals=[
            _bar(wells={"axis": ["hierarchy:nope"], "legend": [],
                        "values": ["ORDERS.TOTAL"]})
        ]))
    assert "hierarchy:nope" in exc.value.message


def test_a_hierarchy_reference_in_a_metric_well_is_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(
            hierarchies=[{"id": "h1", "name": "Geo",
                          "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE"]}],
            visuals=[_bar(wells={"axis": ["CUSTOMERS.REGION"], "legend": [],
                                 "values": ["hierarchy:h1"]})],
        ))
    assert "Values" in exc.value.message


def test_filters_survive_the_export_round_trip():
    """`from` is aliased off a Python keyword, so a between filter is the one
    most likely to lose its wire name on the way out."""
    doc = valid_doc(filters=[
        {"id": "f1", "field": "ORDERS.TOTAL", "op": "between", "from": 1, "to": 9}
    ])
    exported = json.loads(to_export_document(parse_definition(doc)))
    assert exported["filters"][0]["from"] == 1
    assert parse_definition(exported).filters[0].from_ == 1
