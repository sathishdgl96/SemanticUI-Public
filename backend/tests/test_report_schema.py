import json

import pytest

from app.errors import ApiError
from app.reports.schema import (
    MAX_DEFINITION_BYTES,
    MAX_PAGES,
    MAX_REF_LENGTH,
    MAX_REFS_PER_WELL,
    MAX_VISUALS,
    SCHEMA_VERSION,
    parse_definition,
    to_export_document,
)
from tests.test_report_routes import oversized_definition, valid_definition


def valid_visual(**overrides):
    visual = {
        "id": "v1",
        "type": "bar",
        "title": "Revenue by region",
        "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
        "wells": {"axis": ["C.REGION"], "legend": [], "values": ["A.REV"]},
        "options": {"stacked": False},
    }
    visual.update(overrides)
    return visual


def valid_doc(**overrides):
    """A current-version document. `visuals=` and `page_filters=` land on the
    single default page; `pages=` replaces the page list wholesale."""
    visuals = overrides.pop("visuals", [valid_visual()])
    page_filters = overrides.pop("page_filters", [])
    pages = overrides.pop(
        "pages",
        [{"id": "p1", "name": "Page 1", "visuals": visuals, "filters": page_filters}],
    )
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "name": "Sales overview",
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "pages": pages,
        "filters": [],
    }
    doc.update(overrides)
    return doc


def page(pid, name, visuals=None, filters=None):
    return {"id": pid, "name": name, "visuals": visuals or [], "filters": filters or []}


def test_parses_a_valid_document():
    d = parse_definition(valid_doc())
    assert d.name == "Sales overview"
    assert d.view.name == "SALES"
    assert d.pages[0].visuals[0].type == "bar"
    assert d.pages[0].visuals[0].layout.w == 6


def test_rejects_an_unsupported_schema_version():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(schemaVersion=99))
    assert exc.value.code == "REPORT_INVALID"
    assert "schemaVersion" in exc.value.message


def test_rejects_unknown_top_level_and_visual_keys():
    with pytest.raises(ApiError):
        parse_definition(valid_doc(surpriseKey="x"))
    doc = valid_doc()
    doc["pages"][0]["visuals"][0]["surprise"] = 1
    with pytest.raises(ApiError):
        parse_definition(doc)


def test_rejects_an_unknown_visual_type():
    doc = valid_doc(visuals=[valid_visual(type="hologram")])
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "hologram" in exc.value.message


def test_rejects_well_cardinality_violations():
    doc = valid_doc(
        visuals=[valid_visual(wells={"axis": [], "legend": [], "values": ["A.REV"]})]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "Axis" in exc.value.message


def test_rejects_unknown_option_keys():
    doc = valid_doc(
        visuals=[valid_visual(options={"stacked": False, "rainbow": True})]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "rainbow" in exc.value.message


def test_rejects_duplicate_visual_ids():
    doc = valid_doc(visuals=[valid_visual(), valid_visual()])
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "duplicate" in exc.value.message.lower()


def test_rejects_too_many_visuals():
    doc = valid_doc(
        visuals=[valid_visual(id=f"v{i}") for i in range(MAX_VISUALS + 1)]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert str(MAX_VISUALS) in exc.value.message


def test_rejects_a_well_with_too_many_refs():
    values = [f"A.M{i}" for i in range(MAX_REFS_PER_WELL + 1)]
    doc = valid_doc(
        visuals=[
            valid_visual(wells={"axis": ["C.REGION"], "legend": [], "values": values})
        ]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert exc.value.code == "REPORT_INVALID"


def test_rejects_an_overlong_well_ref():
    doc = valid_doc(
        visuals=[
            valid_visual(
                wells={
                    "axis": ["C." + "R" * MAX_REF_LENGTH],
                    "legend": [],
                    "values": ["A.REV"],
                }
            )
        ]
    )
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
    assert d.pages[0].visuals == []


def test_an_unbound_definition_with_a_visual_is_rejected():
    # A visual's fields have to come from somewhere -- an empty view can't
    # back a visual, so this must fail even though each field individually
    # (empty string) is now allowed by the schema.
    doc = valid_doc(view={"database": "", "schema": "", "name": ""})
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert exc.value.code == "REPORT_INVALID"
    assert "semantic view" in exc.value.message.lower()


def test_an_unbound_view_is_caught_on_any_page():
    doc = valid_doc(
        view={"database": "", "schema": "", "name": ""},
        pages=[page("p1", "A"), page("p2", "B", visuals=[valid_visual()])],
    )
    with pytest.raises(ApiError):
        parse_definition(doc)


def test_a_bound_definition_with_visuals_still_parses():
    d = parse_definition(valid_doc())
    assert d.view.name == "SALES"
    assert len(list(d.all_visuals())) == 1


def test_validation_errors_do_not_echo_the_submitted_value():
    marker = "SENSITIVE-MARKER-VALUE"
    doc = valid_doc(
        visuals=[valid_visual(layout={"x": marker, "y": 0, "w": 6, "h": 6})]
    )
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


# --- v3: pages --------------------------------------------------------------


def test_requires_at_least_one_page():
    with pytest.raises(ApiError):
        parse_definition(valid_doc(pages=[]))


def test_rejects_more_than_max_pages():
    pages = [page(f"p{i}", f"Page {i}") for i in range(MAX_PAGES + 1)]
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(pages=pages))
    assert exc.value.code == "REPORT_INVALID"


def test_rejects_duplicate_page_ids():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(pages=[page("p1", "A"), page("p1", "B")]))
    assert "p1" in exc.value.message


def test_rejects_duplicate_page_names():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(pages=[page("p1", "A"), page("p2", "A")]))
    assert "A" in exc.value.message


def test_rejects_duplicate_visual_ids_across_pages():
    doc = valid_doc(
        pages=[
            page("p1", "A", visuals=[valid_visual()]),
            page("p2", "B", visuals=[valid_visual()]),
        ]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "v1" in exc.value.message


def test_max_visuals_counts_across_pages():
    doc = valid_doc(
        pages=[
            page("p1", "A", visuals=[valid_visual(id=f"v{i}") for i in range(30)]),
            page(
                "p2",
                "B",
                visuals=[valid_visual(id=f"v{30 + i}") for i in range(21)],
            ),
        ]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert str(MAX_VISUALS) in exc.value.message


def test_page_filter_ids_are_a_scope_of_their_own():
    f = {"id": "f1", "field": "C.REGION", "op": "is", "values": ["EAST"]}
    # Same id on two DIFFERENT pages is fine; twice on ONE page is not.
    parse_definition(
        valid_doc(
            pages=[
                page("p1", "A", visuals=[valid_visual()], filters=[f]),
                page("p2", "B", filters=[dict(f)]),
            ]
        )
    )
    with pytest.raises(ApiError):
        parse_definition(
            valid_doc(
                pages=[
                    page("p1", "A", visuals=[valid_visual()], filters=[f, dict(f)])
                ]
            )
        )


# --- filters, hierarchies and the migrations --------------------------------


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
    assert definition.schemaVersion == SCHEMA_VERSION == 3
    assert definition.filters == []
    assert definition.hierarchies == []
    assert definition.pages[0].name == "Page 1"


def test_a_v2_document_still_parses_and_its_filters_become_the_page_scope():
    v2 = {
        "schemaVersion": 2,
        "name": "R",
        "view": {"database": "D", "schema": "S", "name": "V"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": [_bar()],
        "filters": [
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
        ],
        "hierarchies": [],
    }
    definition = parse_definition(v2)
    assert definition.schemaVersion == 3
    assert definition.filters == []
    assert definition.pages[0].filters[0].field == "CUSTOMERS.REGION"
    assert definition.pages[0].visuals[0].id == "v1"


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
    assert definition.pages[0].visuals[0].filters[0].op == "relativeDate"


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
    one of them -- report "f1", a page's "f1" and a visual's "f1" never
    collide."""
    definition = parse_definition(valid_doc(
        filters=[{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}],
        page_filters=[{"id": "f1", "field": "CUSTOMERS.STATE", "op": "is", "values": ["CA"]}],
        visuals=[_bar(filters=[
            {"id": "f1", "field": "ORDERS.CHANNEL", "op": "is", "values": ["WEB"]}
        ])],
    ))
    assert definition.filters[0].id == "f1"
    assert definition.pages[0].filters[0].id == "f1"
    assert definition.pages[0].visuals[0].filters[0].id == "f1"


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
    assert definition.pages[0].visuals[0].wells["axis"] == ["hierarchy:h1"]


def test_a_well_referencing_an_undeclared_hierarchy_is_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(visuals=[
            _bar(wells={"axis": ["hierarchy:nope"], "legend": [],
                        "values": ["ORDERS.TOTAL"]})
        ]))
    assert "hierarchy:nope" in exc.value.message


def test_a_hierarchy_reference_on_a_later_page_is_still_checked():
    doc = valid_doc(
        pages=[
            page("p1", "A", visuals=[valid_visual()]),
            page(
                "p2",
                "B",
                visuals=[
                    _bar(
                        id="v2",
                        wells={"axis": ["hierarchy:nope"], "legend": [],
                               "values": ["ORDERS.TOTAL"]},
                    )
                ],
            ),
        ]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
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


# --- colours ----------------------------------------------------------------


def test_a_canvas_background_must_be_a_hex_colour():
    """These values are written into a `style` attribute in the browser. A
    pattern is what stops "red; background: url(...)" ever being one of
    them -- the constraint is the point, not the convenience."""
    assert (
        parse_definition(
            valid_doc(canvas={"columns": 12, "rowHeight": 40, "background": "#0b0b0b"})
        ).canvas.background
        == "#0b0b0b"
    )
    with pytest.raises(ApiError):
        parse_definition(
            valid_doc(
                canvas={
                    "columns": 12,
                    "rowHeight": 40,
                    "background": "red; background: url(http://x)",
                }
            )
        )


def test_a_canvas_background_is_optional():
    # Absent means the product's own canvas grey, so every report saved
    # before this existed keeps the background it has always had.
    assert parse_definition(valid_doc()).canvas.background is None


def sheet_definition():
    """A current-version document with one page, ready to become a sheet."""
    raw = valid_definition()
    from app.reports.migrate import migrate_definition

    return migrate_definition(raw)


class TestSheetPages:
    def test_a_sheet_page_with_one_matrix_is_valid(self):
        raw = sheet_definition()
        raw["pages"][0]["kind"] = "sheet"
        raw["pages"][0]["visuals"] = [{
            "id": "v1", "type": "matrix", "title": "",
            "layout": {"x": 0, "y": 0, "w": 12, "h": 20},
            "wells": {"rows": ["CUSTOMERS.REGION"],
                      "values": ["ORDERS.TOTAL_REVENUE"]},
            "options": {}, "filters": [],
        }]
        parse_definition(raw)  # no raise

    def test_kind_defaults_to_canvas(self):
        definition = parse_definition(valid_definition())
        assert definition.pages[0].kind == "canvas"

    def test_a_sheet_page_refuses_two_visuals(self):
        raw = sheet_definition()
        raw["pages"][0]["kind"] = "sheet"
        visual = {
            "id": "v1", "type": "matrix", "title": "",
            "layout": {"x": 0, "y": 0, "w": 12, "h": 20},
            "wells": {"rows": ["CUSTOMERS.REGION"],
                      "values": ["ORDERS.TOTAL_REVENUE"]},
            "options": {}, "filters": [],
        }
        raw["pages"][0]["visuals"] = [visual, {**visual, "id": "v2"}]
        with pytest.raises(ApiError) as excinfo:
            parse_definition(raw)
        assert "single pivot" in excinfo.value.message

    def test_a_sheet_page_refuses_a_chart(self):
        raw = sheet_definition()
        raw["pages"][0]["kind"] = "sheet"
        raw["pages"][0]["visuals"] = [{
            "id": "v1", "type": "bar", "title": "",
            "layout": {"x": 0, "y": 0, "w": 12, "h": 20},
            "wells": {"axis": ["CUSTOMERS.REGION"],
                      "values": ["ORDERS.TOTAL_REVENUE"]},
            "options": {}, "filters": [],
        }]
        with pytest.raises(ApiError) as excinfo:
            parse_definition(raw)
        assert "matrix or table" in excinfo.value.message
