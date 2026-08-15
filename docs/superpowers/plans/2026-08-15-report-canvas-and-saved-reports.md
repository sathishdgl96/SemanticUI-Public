# Report Canvas & Saved Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user builds a report of several visuals over one semantic view, arranges them on a 12-column snap grid, saves it, reopens it, and moves it between deployments by copying its JSON definition.

**Architecture:** Report definitions live as a JSON document in a new `reports` table alongside real columns for owner/name/bound-view. Each visual issues its own `POST /api/query/semantic` so tiles render progressively; the repeated `DESCRIBE` is cached inside the caller's own connection-cache entry. Imported documents are untrusted input — capped, strictly parsed, and every field reference re-validated against a live DESCRIBE on the importer's connection.

**Tech Stack:** Existing — Python 3.12 / FastAPI / SQLAlchemy 2.0 / Alembic / snowflake-connector-python; React 18 / TypeScript / Vite / TanStack Query / dnd-kit / ECharts. New: `react-grid-layout` (frontend only).

**Spec:** `docs/superpowers/specs/2026-08-15-report-canvas-and-saved-reports-design.md`

## Global Constraints

Inherited from sub-project 1 and still binding:

- All FastAPI endpoints are **sync `def`**; locks are `threading.Lock`, never asyncio.
- Env prefix `SEMANTICUI_`; settings via pydantic-settings.
- Error envelope everywhere: `{"code","message","detail"}`. Existing codes: `AUTH_EXPIRED` 401, `AUTH_FAILED` 400/401, `SNOWFLAKE_FORBIDDEN` 403, `QUERY_ERROR` 400, `TIMEOUT` 504, `VALIDATION_ERROR` 422, `HTTP_ERROR`, `INTERNAL_ERROR` 500. **New in this plan:** `REPORT_INVALID` 400.
- All SQL is built server-side; identifiers are validated against a live `DESCRIBE SEMANTIC VIEW` and quoted with `quote_ident`, which rejects any identifier containing `"`.
- Every Snowflake statement runs on the requesting user's own cached connection. No service account, no shared connection, no cross-user cache.
- Report rows store **definitions only**. Query results are never persisted.
- Report access is owner-scoped. A report owned by someone else returns **404, not 403**.
- Imported definitions are untrusted: 64 KB body cap, 50 visuals per report, strict schema with unknown fields rejected, `schemaVersion` checked, every field ref re-validated against the importer's own DESCRIBE.
- Exports carry no owner, no timestamps, no report id, no data, no credentials, and serialise with sorted keys so two exports of an unchanged report are byte-identical.
- `npm run typecheck` (`tsc -b --noEmit`) and `npm run lint` must stay green. No `any`, no `@ts-expect-error`.
- Chart colours come only from `frontend/src/query/palette.ts`. Its eight hex values and their order are a validated colourblind-safe set — never modify, reorder, or extend them. UI chrome is never painted in a series colour.
- Drag is never the only path to an action; every drag interaction has a click or keyboard equivalent. Focus outlines are never removed. Hit targets clear 24px.
- Dense-analytical visual language: system sans for interface voice, `--font-mono` for database identifiers, `tabular-nums` on numeric cells.
- Responsive breakpoints already exist at 1280 / 960 / 600; new UI must not introduce horizontal page scroll at 1440, 1280, 1024, 768 or 390px.
- TDD: write the failing test, run it to see it fail, implement, run it to see it pass. Commit at the end of every task.
- Backend tests run from `backend/` as `.venv/Scripts/python.exe -m pytest`. Frontend from `frontend/` as `npm test`.

## File Map

```
backend/
  app/config.py                     # + describe_cache_ttl_seconds
  app/db/models.py                  # + Report
  migrations/versions/0002_reports.py
  app/reports/__init__.py
  app/reports/catalog.py            # visual types, wells, well->query mapping
  app/reports/schema.py             # pydantic definition document + validation
  app/reports/service.py            # owner-scoped CRUD, export doc, import
  app/reports/routes.py             # /api/reports/*
  app/snowflake/provider.py         # + per-entry describe cache
  app/semantic/routes.py            # use the describe cache
  tests/test_report_catalog.py  test_report_schema.py
  tests/test_report_routes.py   test_report_import.py  test_describe_cache.py
frontend/
  src/api/types.ts                  # + report types
  src/api/reports.ts                # report API client functions
  src/reports/catalog.ts            # per-type wells + query mapping (mirrors backend)
  src/reports/ReportListPage.tsx
  src/reports/BuilderPage.tsx       # shell: canvas + panes
  src/reports/CanvasGrid.tsx        # react-grid-layout wrapper
  src/reports/VisualTile.tsx        # one visual: header, render, error isolation
  src/reports/VisualPicker.tsx      # chart-type grid
  src/reports/VisualWells.tsx       # wells for the selected visual (per-type)
  src/reports/ExportPanel.tsx  ImportPanel.tsx
  src/reports/useReportQuery.ts     # per-visual query hook
  src/query/renderers/*.ts          # option builders per visual type
  src/App.tsx                       # routes: /reports, /reports/:id, /explore
```

---

### Task 1: Report model, migration, and the describe-cache setting

**Files:**
- Modify: `backend/app/db/models.py`, `backend/app/config.py`
- Create: `backend/migrations/versions/0002_reports.py`
- Test: `backend/tests/test_models.py` (append)

**Interfaces:**
- Consumes: `Base`, `User`, `now_utc` from `app.db.models`; `Settings` from `app.config`.
- Produces: `Report` model with columns `id: uuid`, `owner_user_id: uuid FK users.id`, `name: str`, `view_database: str`, `view_schema: str`, `view_name: str`, `definition: dict` (JSON), `created_at`, `updated_at`; `Settings.describe_cache_ttl_seconds: int = 300`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_models.py`:

```python
def test_report_belongs_to_user_and_stores_a_json_definition(db):
    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.commit()
    report = Report(
        owner_user_id=user.id,
        name="Sales overview",
        view_database="ANALYTICS",
        view_schema="PUBLIC",
        view_name="SALES",
        definition={"schemaVersion": 1, "visuals": []},
    )
    db.add(report)
    db.commit()
    loaded = db.get(Report, report.id)
    assert loaded.owner_user_id == user.id
    assert loaded.definition["schemaVersion"] == 1
    assert loaded.definition["visuals"] == []
    assert isinstance(loaded.id, uuid.UUID)
```

Add `Report` to the imports at the top of that file.

Append to `backend/tests/test_config.py`:

```python
def test_describe_cache_ttl_default():
    assert Settings(_env_file=None).describe_cache_ttl_seconds == 300
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest tests/test_models.py tests/test_config.py -v`
Expected: FAIL — `ImportError: cannot import name 'Report'`, and the settings field is missing.

- [ ] **Step 3: Add the setting**

In `backend/app/config.py`, beside the other connection settings:

```python
    describe_cache_ttl_seconds: int = 300
```

- [ ] **Step 4: Add the model**

In `backend/app/db/models.py` add the import `from sqlalchemy import JSON` to the existing sqlalchemy import line, then append:

```python
class Report(Base):
    __tablename__ = "reports"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    view_database: Mapped[str] = mapped_column(String(255))
    view_schema: Mapped[str] = mapped_column(String(255))
    view_name: Mapped[str] = mapped_column(String(255))
    #: The portable definition document. JSONB on Postgres, JSON on SQLite.
    definition: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )
```

- [ ] **Step 5: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_models.py tests/test_config.py -v`
Expected: PASS.

- [ ] **Step 6: Write the migration**

`backend/migrations/versions/0002_reports.py`:

```python
"""reports

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("view_database", sa.String(255), nullable=False),
        sa.Column("view_schema", sa.String(255), nullable=False),
        sa.Column("view_name", sa.String(255), nullable=False),
        sa.Column("definition", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_reports_owner_user_id", "reports", ["owner_user_id"])


def downgrade() -> None:
    op.drop_index("ix_reports_owner_user_id", table_name="reports")
    op.drop_table("reports")
```

- [ ] **Step 7: Verify the migration applies**

Run: `.venv/Scripts/python.exe -m alembic upgrade head`
Expected: exit 0. Then `.venv/Scripts/python.exe -m alembic current` shows `0002`.
(If the local SQLite database does not exist, this creates it — that is fine.)

- [ ] **Step 8: Run the full backend suite**

Run: `.venv/Scripts/python.exe -m pytest -q`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add backend/app/db/models.py backend/app/config.py backend/migrations backend/tests
git commit -m "feat: reports table and describe-cache setting"
```

---

### Task 2: Visual catalog and well→query mapping (backend)

**Files:**
- Create: `backend/app/reports/__init__.py`, `backend/app/reports/catalog.py`
- Test: `backend/tests/test_report_catalog.py`

**Interfaces:**
- Consumes: nothing outside stdlib.
- Produces: `FieldKind = Literal["dimension","metric"]`; `WellSpec(name: str, kind: FieldKind, min: int, max: int | None)`; `VisualSpec(type: str, wells: tuple[WellSpec, ...], options: frozenset[str])`; `CATALOG: dict[str, VisualSpec]` keyed by the seven type names; `wells_to_query(visual_type: str, wells: dict[str, list[str]]) -> tuple[list[str], list[str]]` returning `(dimensions, metrics)`; `validate_wells(visual_type, wells) -> list[str]` returning human-readable problems (empty list = valid).

The catalog is the single source of truth for what each visual accepts. The frontend mirrors it in `frontend/src/reports/catalog.ts`; both are covered by tests so they cannot drift silently.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_report_catalog.py`:

```python
import pytest

from app.reports.catalog import (
    CATALOG,
    validate_wells,
    wells_to_query,
)


def test_catalog_contains_the_core_seven():
    assert set(CATALOG) == {"bar", "line", "area", "pie", "scatter", "table", "kpi"}


def test_bar_maps_axis_and_legend_to_dimensions():
    dims, mets = wells_to_query(
        "bar",
        {"axis": ["A.DATE"], "legend": ["C.REGION"], "values": ["A.REV", "A.QTY"]},
    )
    assert dims == ["A.DATE", "C.REGION"]
    assert mets == ["A.REV", "A.QTY"]


def test_scatter_puts_two_metrics_on_the_axes():
    dims, mets = wells_to_query(
        "scatter", {"x": ["A.REV"], "y": ["A.QTY"], "detail": ["C.REGION"]}
    )
    assert dims == ["C.REGION"]
    assert mets == ["A.REV", "A.QTY"]


def test_kpi_has_no_dimensions():
    dims, mets = wells_to_query("kpi", {"value": ["A.REV"]})
    assert dims == []
    assert mets == ["A.REV"]


def test_pie_requires_exactly_one_metric():
    assert validate_wells("pie", {"legend": ["C.REGION"], "values": ["A.REV"]}) == []
    problems = validate_wells(
        "pie", {"legend": ["C.REGION"], "values": ["A.REV", "A.QTY"]}
    )
    assert problems and "at most 1" in problems[0]


def test_missing_required_well_is_reported():
    problems = validate_wells("bar", {"axis": [], "legend": [], "values": ["A.REV"]})
    assert problems and "Axis" in problems[0]


def test_table_needs_at_least_one_field_overall():
    assert validate_wells("table", {"dimensions": ["C.REGION"], "metrics": []}) == []
    problems = validate_wells("table", {"dimensions": [], "metrics": []})
    assert problems and "at least one field" in problems[0]


def test_a_field_may_not_appear_in_two_wells():
    problems = validate_wells(
        "bar", {"axis": ["A.DATE"], "legend": ["A.DATE"], "values": ["A.REV"]}
    )
    assert problems and "more than one well" in problems[0]


def test_unknown_well_and_unknown_type_are_rejected():
    problems = validate_wells("bar", {"axis": ["A.DATE"], "values": ["A.REV"], "bogus": []})
    assert problems and "bogus" in problems[0]
    with pytest.raises(KeyError):
        wells_to_query("nosuchtype", {})
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest tests/test_report_catalog.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.reports'`.

- [ ] **Step 3: Implement the catalog**

`backend/app/reports/__init__.py`: empty file.

`backend/app/reports/catalog.py`:

```python
"""The visual catalog: what each visual type accepts and how it queries.

Wells are declared per visual type rather than shared, because scatter needs
two *metrics* on its axes while bar/line/area need a dimension on one. A fixed
Axis/Legend/Values triple cannot express both.

`frontend/src/reports/catalog.ts` mirrors this file. Both are tested against
the same expectations so they cannot drift apart silently.
"""

from dataclasses import dataclass
from typing import Literal

FieldKind = Literal["dimension", "metric"]


@dataclass(frozen=True)
class WellSpec:
    key: str
    label: str
    kind: FieldKind
    min: int
    max: int | None  # None = unbounded


@dataclass(frozen=True)
class VisualSpec:
    type: str
    label: str
    wells: tuple[WellSpec, ...]
    #: Option keys this type understands; anything else is rejected on import.
    options: frozenset[str]

    def well(self, key: str) -> WellSpec | None:
        return next((w for w in self.wells if w.key == key), None)


_CATEGORICAL = (
    WellSpec("axis", "Axis", "dimension", 1, 1),
    WellSpec("legend", "Legend", "dimension", 0, 1),
    WellSpec("values", "Values", "metric", 1, None),
)

CATALOG: dict[str, VisualSpec] = {
    "bar": VisualSpec("bar", "Bar", _CATEGORICAL, frozenset({"stacked"})),
    "line": VisualSpec("line", "Line", _CATEGORICAL, frozenset()),
    "area": VisualSpec("area", "Area", _CATEGORICAL, frozenset({"stacked"})),
    "pie": VisualSpec(
        "pie",
        "Pie",
        (
            WellSpec("legend", "Legend", "dimension", 1, 1),
            WellSpec("values", "Values", "metric", 1, 1),
        ),
        frozenset({"donut"}),
    ),
    "scatter": VisualSpec(
        "scatter",
        "Scatter",
        (
            WellSpec("x", "X axis", "metric", 1, 1),
            WellSpec("y", "Y axis", "metric", 1, 1),
            WellSpec("detail", "Detail", "dimension", 0, 1),
        ),
        frozenset(),
    ),
    "table": VisualSpec(
        "table",
        "Table",
        (
            WellSpec("dimensions", "Dimensions", "dimension", 0, None),
            WellSpec("metrics", "Metrics", "metric", 0, None),
        ),
        frozenset(),
    ),
    "kpi": VisualSpec(
        "kpi",
        "KPI card",
        (WellSpec("value", "Value", "metric", 1, 1),),
        frozenset({"format"}),
    ),
}


def wells_to_query(
    visual_type: str, wells: dict[str, list[str]]
) -> tuple[list[str], list[str]]:
    """Flatten a visual's wells into the (dimensions, metrics) the query API takes.

    Order matters: dimensions come out in well-declaration order, so for a bar
    the axis precedes the legend and the caller can rely on that when pivoting.
    """
    spec = CATALOG[visual_type]
    dimensions: list[str] = []
    metrics: list[str] = []
    for well in spec.wells:
        target = dimensions if well.kind == "dimension" else metrics
        target.extend(wells.get(well.key, []))
    return dimensions, metrics


def validate_wells(visual_type: str, wells: dict[str, list[str]]) -> list[str]:
    """Return human-readable problems with this well arrangement; [] if valid."""
    spec = CATALOG.get(visual_type)
    if spec is None:
        return [f"Unknown visual type: {visual_type}"]

    problems: list[str] = []
    known = {w.key for w in spec.wells}
    for key in wells:
        if key not in known:
            problems.append(f"{spec.label} has no well named {key!r} (bogus well)")

    seen: dict[str, str] = {}
    for well in spec.wells:
        refs = wells.get(well.key, [])
        if len(refs) < well.min:
            problems.append(f"{well.label} needs at least {well.min} field(s)")
        if well.max is not None and len(refs) > well.max:
            problems.append(f"{well.label} takes at most {well.max} field(s)")
        for ref in refs:
            if ref in seen:
                problems.append(
                    f"{ref} appears in more than one well ({seen[ref]} and {well.label})"
                )
            else:
                seen[ref] = well.label

    if visual_type == "table" and not seen:
        problems.append("Table needs at least one field")
    return problems
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_report_catalog.py -v`
Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/reports backend/tests/test_report_catalog.py
git commit -m "feat: visual catalog with per-type wells and query mapping"
```

---

### Task 3: Definition document schema and validation

**Files:**
- Create: `backend/app/reports/schema.py`
- Test: `backend/tests/test_report_schema.py`

**Interfaces:**
- Consumes: `CATALOG`, `validate_wells` (Task 2); `ApiError` from `app.errors`.
- Produces: `SCHEMA_VERSION = 1`; `MAX_VISUALS = 50`; `MAX_DEFINITION_BYTES = 65536`; pydantic models `ViewRef(database, schema_ alias "schema", name)`, `VisualLayout(x, y, w, h)`, `Visual(id, type, title, layout, wells, options)`, `CanvasSettings(columns=12, rowHeight=40)`, `ReportDefinition(schemaVersion, name, view, canvas, visuals)`; `parse_definition(raw: dict) -> ReportDefinition` raising `ApiError("REPORT_INVALID", 400, ...)`; `to_export_document(definition: ReportDefinition) -> str` producing sorted-key, 2-space-indented JSON.

All models set `model_config = ConfigDict(extra="forbid")` so an unknown key is a visible error rather than silent data loss.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_report_schema.py`:

```python
import json

import pytest

from app.errors import ApiError
from app.reports.schema import (
    MAX_VISUALS,
    SCHEMA_VERSION,
    parse_definition,
    to_export_document,
)


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


def test_export_document_is_deterministic_and_sorted():
    a = to_export_document(parse_definition(valid_doc()))
    b = to_export_document(parse_definition(valid_doc()))
    assert a == b
    parsed = json.loads(a)
    assert list(parsed) == sorted(parsed)
    # No identity, timestamps or ids leak into the portable document.
    assert "owner" not in a and "createdAt" not in a and "updatedAt" not in a
    assert a.endswith("\n")
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest tests/test_report_schema.py -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the schema**

`backend/app/reports/schema.py`:

```python
"""The portable report definition document.

This is exactly what `GET /api/reports/{id}/export` emits and what
`POST /api/reports/import` accepts, so it is parsed defensively: unknown keys
are refused rather than dropped, every visual is checked against the catalog,
and the whole thing is size-bounded.
"""

import json

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import ApiError
from app.reports.catalog import CATALOG, validate_wells

SCHEMA_VERSION = 1
MAX_VISUALS = 50
MAX_DEFINITION_BYTES = 65536


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ViewRef(_Strict):
    database: str = Field(min_length=1, max_length=255)
    schema_: str = Field(alias="schema", min_length=1, max_length=255)
    name: str = Field(min_length=1, max_length=255)


class VisualLayout(_Strict):
    x: int = Field(ge=0, le=11)
    y: int = Field(ge=0, le=999)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=100)


class Visual(_Strict):
    id: str = Field(min_length=1, max_length=64)
    type: str
    title: str = Field(default="", max_length=200)
    layout: VisualLayout
    wells: dict[str, list[str]] = Field(default_factory=dict)
    options: dict[str, object] = Field(default_factory=dict)


class CanvasSettings(_Strict):
    columns: int = Field(default=12, ge=1, le=24)
    rowHeight: int = Field(default=40, ge=10, le=200)


class ReportDefinition(_Strict):
    schemaVersion: int
    name: str = Field(min_length=1, max_length=200)
    view: ViewRef
    canvas: CanvasSettings = Field(default_factory=CanvasSettings)
    visuals: list[Visual] = Field(default_factory=list)


def _invalid(message: str, detail: str | None = None) -> ApiError:
    return ApiError("REPORT_INVALID", 400, message, detail=detail)


def parse_definition(raw: dict) -> ReportDefinition:
    """Validate an untrusted definition document. Raises ApiError on any problem."""
    if not isinstance(raw, dict):
        raise _invalid("A report definition must be a JSON object")

    version = raw.get("schemaVersion")
    if version != SCHEMA_VERSION:
        raise _invalid(
            f"Unsupported schemaVersion {version!r}; this build reads version "
            f"{SCHEMA_VERSION}"
        )

    visuals = raw.get("visuals")
    if isinstance(visuals, list) and len(visuals) > MAX_VISUALS:
        raise _invalid(f"A report may hold at most {MAX_VISUALS} visuals")

    try:
        definition = ReportDefinition.model_validate(raw)
    except ValidationError as exc:
        # Pydantic's own text names the offending path, which is what the user
        # needs; it contains only their own submitted structure.
        raise _invalid("The report definition is not valid", detail=str(exc.errors()))

    seen_ids: set[str] = set()
    for visual in definition.visuals:
        if visual.id in seen_ids:
            raise _invalid(f"Duplicate visual id {visual.id!r}")
        seen_ids.add(visual.id)

        spec = CATALOG.get(visual.type)
        if spec is None:
            raise _invalid(f"Unknown visual type {visual.type!r}")

        unknown_options = set(visual.options) - spec.options
        if unknown_options:
            raise _invalid(
                f"Visual {visual.id!r} has unknown option(s): "
                + ", ".join(sorted(unknown_options))
            )

        problems = validate_wells(visual.type, visual.wells)
        if problems:
            raise _invalid(f"Visual {visual.id!r}: {problems[0]}")

    return definition


def to_export_document(definition: ReportDefinition) -> str:
    """Serialise a definition portably: sorted keys, stable indent, trailing newline.

    Two exports of an unchanged report are byte-identical, so the file diffs
    cleanly in version control.
    """
    payload = definition.model_dump(by_alias=True, mode="json")
    return json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_report_schema.py -v`
Expected: 9 PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `.venv/Scripts/python.exe -m pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/app/reports/schema.py backend/tests/test_report_schema.py
git commit -m "feat: strict report definition schema with deterministic export"
```

---

### Task 4: Per-session DESCRIBE cache

**Files:**
- Modify: `backend/app/snowflake/provider.py`, `backend/app/semantic/routes.py`
- Test: `backend/tests/test_describe_cache.py`

**Interfaces:**
- Consumes: `CacheEntry`, `ConnectionCache` (sub-project 1); `describe_semantic_view` from `app.semantic.discovery`; `get_settings()`.
- Produces: `CacheEntry.describe_cache: dict[str, tuple[float, dict]]` (key = `"DB.SCHEMA.VIEW"`, value = `(stored_at, detail)`); `ConnectionCache.describe(entry, database, schema, name, *, force=False) -> dict` — returns a cached describe or fetches and stores one; `ConnectionCache.invalidate_describe(entry, database, schema, name) -> None`.

**Why this is safe:** the cache lives *inside* the per-session `CacheEntry`, alongside that user's connection. There is no process-global describe map, so one user's catalog can never be served to another, and it dies when their session's entry is evicted. The entry's existing lock guards it.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_describe_cache.py`:

```python
from app.auth.sessions import create_session
from app.snowflake import connect as sf_connect
from app.snowflake.provider import ConnectionCache
from tests.fakes import FakeConnection


DESCRIBE_A = {"tables": [{"name": "ORDERS"}], "relationships": [],
              "dimensions": [], "metrics": [], "facts": []}


def make_entry(cache, db, account="ACME", user="ALICE"):
    sess = create_session(db, account=account, user=user, mode="dev")
    conn = FakeConnection()
    cache.put(sess.id, conn, rebuildable=False)
    return sess, cache.acquire(db, sess)


def test_describe_is_fetched_once_and_then_served_from_cache(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append((d, s, n)) or DESCRIBE_A,
    )
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    _sess, entry = make_entry(cache, db)

    first = cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    second = cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    assert first == DESCRIBE_A and second == DESCRIBE_A
    assert len(calls) == 1, "second call should have been served from the cache"


def test_a_different_view_is_a_different_cache_key(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append(n) or DESCRIBE_A,
    )
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    _sess, entry = make_entry(cache, db)
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    cache.describe(entry, "ANALYTICS", "PUBLIC", "OPS")
    assert calls == ["SALES", "OPS"]


def test_cache_expires_after_the_ttl(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append(n) or DESCRIBE_A,
    )
    now = [1000.0]
    cache = ConnectionCache(
        idle_ttl=900, max_size=10, retain_ttl=28800, clock=lambda: now[0]
    )
    _sess, entry = make_entry(cache, db)
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    now[0] += 301  # past the 300s default
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    assert len(calls) == 2


def test_force_and_invalidate_refetch(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append(n) or DESCRIBE_A,
    )
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    _sess, entry = make_entry(cache, db)
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES", force=True)
    assert len(calls) == 2
    cache.invalidate_describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    assert len(calls) == 3


def test_two_sessions_never_share_a_describe(db, monkeypatch):
    """The whole point of putting the cache inside the entry."""
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append(n) or DESCRIBE_A,
    )
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    _a, entry_a = make_entry(cache, db, user="ALICE")
    _b, entry_b = make_entry(cache, db, user="BOB")
    cache.describe(entry_a, "ANALYTICS", "PUBLIC", "SALES")
    cache.describe(entry_b, "ANALYTICS", "PUBLIC", "SALES")
    assert len(calls) == 2, "Bob must not be served Alice's cached catalog"
    assert entry_a.describe_cache is not entry_b.describe_cache
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest tests/test_describe_cache.py -v`
Expected: FAIL — `AttributeError: 'ConnectionCache' object has no attribute 'describe'`.

- [ ] **Step 3: Implement the cache**

In `backend/app/snowflake/provider.py`, add the import near the top:

```python
from app.semantic.discovery import describe_semantic_view
```

(If this creates a circular import because `discovery` imports from `provider`, move the import inside the `describe` method body and note it in your report — `discovery` currently imports only from `app.errors` and `app.snowflake.gateway`, so a module-level import should be fine.)

Extend `CacheEntry` with the cache field:

```python
    #: Per-view DESCRIBE results for THIS session only, keyed "DB.SCHEMA.VIEW"
    #: → (stored_at, detail). Lives inside the entry so one user's catalog can
    #: never be served to another; dies when the entry is evicted.
    describe_cache: dict[str, tuple[float, dict]] = field(default_factory=dict)
```

Add to `ConnectionCache`:

```python
    @staticmethod
    def _describe_key(database: str, schema: str, name: str) -> str:
        return f"{database}.{schema}.{name}"

    def describe(
        self,
        entry: CacheEntry,
        database: str,
        schema: str,
        name: str,
        *,
        force: bool = False,
    ) -> dict:
        """Return the semantic view's description, cached per session.

        A report issues one query per visual and each validates its field
        references against a DESCRIBE; without this every refresh would run N
        identical describes. The caller must hold `entry.lock`, as it already
        does for the query it is about to build.
        """
        key = self._describe_key(database, schema, name)
        ttl = get_settings().describe_cache_ttl_seconds
        now = self._clock()
        if not force:
            cached = entry.describe_cache.get(key)
            if cached is not None and (now - cached[0]) < ttl:
                return cached[1]
        detail = describe_semantic_view(entry.conn, database, schema, name)
        entry.describe_cache[key] = (now, detail)
        return detail

    def invalidate_describe(
        self, entry: CacheEntry, database: str, schema: str, name: str
    ) -> None:
        entry.describe_cache.pop(self._describe_key(database, schema, name), None)
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_describe_cache.py -v`
Expected: 5 PASS.

- [ ] **Step 5: Use the cache from the semantic routes**

In `backend/app/semantic/routes.py`, in `query_semantic`, replace the direct describe call with the cached one, and add a `refresh` flag to the describe endpoint. The route currently reads:

```python
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        detail = discovery.describe_semantic_view(
            entry.conn, req.database, req.schema_, req.view
        )
```

becomes:

```python
    cache = get_cache()
    entry = cache.acquire(db, sess)
    with entry.lock:
        detail = cache.describe(entry, req.database, req.schema_, req.view)
```

And `describe_view` gains an optional refresh so the builder's "Refresh fields" action can bypass the cache:

```python
@router.get("/api/semantic-views/{database}/{schema}/{name}")
def describe_view(
    database: str,
    schema: str,
    name: str,
    refresh: bool = False,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    cache = get_cache()
    entry = cache.acquire(db, sess)
    with entry.lock:
        return cache.describe(entry, database, schema, name, force=refresh)
```

- [ ] **Step 6: Run the full backend suite**

Run: `.venv/Scripts/python.exe -m pytest -q`
Expected: all pass. The existing `test_semantic_routes.py` tests still pass because the scripted cursor still receives a DESCRIBE on the first call.

- [ ] **Step 7: Commit**

```bash
git add backend/app/snowflake/provider.py backend/app/semantic/routes.py backend/tests/test_describe_cache.py
git commit -m "feat: per-session describe cache so a report costs one describe"
```

---

### Task 5: Reports service and CRUD routes

**Files:**
- Create: `backend/app/reports/service.py`, `backend/app/reports/routes.py`
- Modify: `backend/app/main.py` (include router)
- Test: `backend/tests/test_report_routes.py`

**Interfaces:**
- Consumes: `Report`, `User` (Task 1); `parse_definition`, `to_export_document`, `ReportDefinition` (Task 3); `current_session` from `app.auth.routes`; `get_db`.
- Produces: service functions `list_reports(db, user_id) -> list[Report]`, `get_owned_report(db, user_id, report_id) -> Report` (raises `ApiError("HTTP_ERROR", 404, "Report not found")` when missing **or owned by someone else**), `create_report(db, user_id, definition) -> Report`, `update_report(db, user_id, report_id, definition) -> Report`, `delete_report(db, user_id, report_id) -> None`; routes `GET/POST /api/reports`, `GET/PUT/DELETE /api/reports/{id}`, `GET /api/reports/{id}/export`.
- Response shapes: list item `{"id","name","view":{"database","schema","name"},"updatedAt"}`; detail adds `"definition"`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_report_routes.py`:

```python
import json

from sqlalchemy import select

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, User


def valid_definition(name="Sales overview"):
    return {
        "schemaVersion": 1,
        "name": name,
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


def sign_in(client, db, user="ALICE"):
    sess = create_session(db, account="ACME", user=user, mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def test_reports_require_authentication(client):
    assert client.get("/api/reports").status_code == 401
    assert client.post("/api/reports", json={"definition": valid_definition()}).status_code == 401


def test_create_list_get_update_delete(client, db):
    sign_in(client, db)

    created = client.post("/api/reports", json={"definition": valid_definition()})
    assert created.status_code == 201
    report_id = created.json()["id"]
    assert created.json()["name"] == "Sales overview"
    assert created.json()["view"]["name"] == "SALES"

    listing = client.get("/api/reports")
    assert listing.status_code == 200
    assert [r["id"] for r in listing.json()["reports"]] == [report_id]
    assert "definition" not in listing.json()["reports"][0]

    detail = client.get(f"/api/reports/{report_id}")
    assert detail.status_code == 200
    assert detail.json()["definition"]["visuals"][0]["id"] == "v1"

    renamed = valid_definition(name="Renamed")
    updated = client.put(f"/api/reports/{report_id}", json={"definition": renamed})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"
    assert client.get(f"/api/reports/{report_id}").json()["name"] == "Renamed"

    assert client.delete(f"/api/reports/{report_id}").status_code == 204
    assert client.get(f"/api/reports/{report_id}").status_code == 404


def test_another_users_report_is_404_not_403(client, db):
    """Non-owners must not be able to distinguish 'exists' from 'not yours'."""
    sign_in(client, db, user="ALICE")
    report_id = client.post("/api/reports", json={"definition": valid_definition()}).json()["id"]

    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    client.cookies.set(SESSION_COOKIE, bob.id)
    assert client.get("/api/reports").json()["reports"] == []
    assert client.get(f"/api/reports/{report_id}").status_code == 404
    assert client.put(f"/api/reports/{report_id}", json={"definition": valid_definition()}).status_code == 404
    assert client.delete(f"/api/reports/{report_id}").status_code == 404


def test_invalid_definition_is_rejected(client, db):
    sign_in(client, db)
    bad = valid_definition()
    bad["visuals"][0]["type"] = "hologram"
    response = client.post("/api/reports", json={"definition": bad})
    assert response.status_code == 400
    assert response.json()["code"] == "REPORT_INVALID"


def test_export_is_deterministic_and_carries_no_identity(client, db):
    sign_in(client, db)
    report_id = client.post("/api/reports", json={"definition": valid_definition()}).json()["id"]
    first = client.get(f"/api/reports/{report_id}/export")
    second = client.get(f"/api/reports/{report_id}/export")
    assert first.status_code == 200
    assert first.text == second.text
    assert report_id not in first.text
    for leaked in ("ALICE", "ACME", "owner", "createdAt", "updatedAt"):
        assert leaked not in first.text
    assert json.loads(first.text)["view"]["name"] == "SALES"


def test_report_row_stores_no_query_results(client, db):
    sign_in(client, db)
    client.post("/api/reports", json={"definition": valid_definition()})
    row = db.scalars(select(Report)).one()
    assert set(row.definition) == {"schemaVersion", "name", "view", "canvas", "visuals"}
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest tests/test_report_routes.py -v`
Expected: FAIL — 404s for every route (router not registered).

- [ ] **Step 3: Implement the service**

`backend/app/reports/service.py`:

```python
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Report
from app.errors import ApiError
from app.reports.schema import ReportDefinition, parse_definition


def _not_found() -> ApiError:
    # 404 rather than 403: a non-owner must not learn that this id exists.
    return ApiError("HTTP_ERROR", 404, "Report not found")


def list_reports(db: Session, user_id: uuid.UUID) -> list[Report]:
    return list(
        db.scalars(
            select(Report)
            .where(Report.owner_user_id == user_id)
            .order_by(Report.updated_at.desc())
        )
    )


def get_owned_report(db: Session, user_id: uuid.UUID, report_id: str) -> Report:
    try:
        key = uuid.UUID(str(report_id))
    except (ValueError, AttributeError):
        raise _not_found()
    report = db.get(Report, key)
    if report is None or report.owner_user_id != user_id:
        raise _not_found()
    return report


def _apply(report: Report, definition: ReportDefinition) -> None:
    report.name = definition.name
    report.view_database = definition.view.database
    report.view_schema = definition.view.schema_
    report.view_name = definition.view.name
    report.definition = definition.model_dump(by_alias=True, mode="json")


def create_report(db: Session, user_id: uuid.UUID, raw_definition: dict) -> Report:
    definition = parse_definition(raw_definition)
    report = Report(owner_user_id=user_id, name=definition.name,
                    view_database="", view_schema="", view_name="", definition={})
    _apply(report, definition)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def update_report(
    db: Session, user_id: uuid.UUID, report_id: str, raw_definition: dict
) -> Report:
    report = get_owned_report(db, user_id, report_id)
    _apply(report, parse_definition(raw_definition))
    db.commit()
    db.refresh(report)
    return report


def delete_report(db: Session, user_id: uuid.UUID, report_id: str) -> None:
    report = get_owned_report(db, user_id, report_id)
    db.delete(report)
    db.commit()
```

- [ ] **Step 4: Implement the routes**

`backend/app/reports/routes.py`:

```python
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, Report
from app.reports import service
from app.reports.schema import parse_definition, to_export_document

router = APIRouter()


class DefinitionBody(BaseModel):
    definition: dict


def _summary(report: Report) -> dict:
    return {
        "id": str(report.id),
        "name": report.name,
        "view": {
            "database": report.view_database,
            "schema": report.view_schema,
            "name": report.view_name,
        },
        "updatedAt": report.updated_at.isoformat(),
    }


def _detail(report: Report) -> dict:
    return {**_summary(report), "definition": report.definition}


@router.get("/api/reports")
def list_reports(
    sess: DbSession = Depends(current_session), db: Session = Depends(get_db)
) -> dict:
    return {"reports": [_summary(r) for r in service.list_reports(db, sess.user_id)]}


@router.post("/api/reports", status_code=201)
def create_report(
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return _detail(service.create_report(db, sess.user_id, body.definition))


@router.get("/api/reports/{report_id}")
def get_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return _detail(service.get_owned_report(db, sess.user_id, report_id))


@router.put("/api/reports/{report_id}")
def update_report(
    report_id: str,
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return _detail(service.update_report(db, sess.user_id, report_id, body.definition))


@router.delete("/api/reports/{report_id}", status_code=204)
def delete_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.delete_report(db, sess.user_id, report_id)
    return Response(status_code=204)


@router.get("/api/reports/{report_id}/export")
def export_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    report = service.get_owned_report(db, sess.user_id, report_id)
    document = to_export_document(parse_definition(report.definition))
    return Response(content=document, media_type="application/json")
```

In `backend/app/main.py`, beside the other router includes inside `create_app()`:

```python
    from app.reports.routes import router as reports_router

    app.include_router(reports_router)
```

- [ ] **Step 5: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_report_routes.py -v`
Expected: 6 PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `.venv/Scripts/python.exe -m pytest -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/reports backend/app/main.py backend/tests/test_report_routes.py
git commit -m "feat: owner-scoped report CRUD with deterministic export"
```

---

### Task 6: Import endpoint

**Files:**
- Modify: `backend/app/reports/service.py`, `backend/app/reports/routes.py`
- Test: `backend/tests/test_report_import.py`

**Interfaces:**
- Consumes: everything from Task 5; `get_cache()` and `ConnectionCache.describe` (Task 4); `wells_to_query` (Task 2).
- Produces: `import_report(db, user_id, entry, cache, raw_definition, view_override: dict | None) -> Report`; route `POST /api/reports/import` accepting `{"definition": {...}, "viewOverride": {"database","schema","name"} | null}` and returning the created report detail with 201.
- New error paths: `REPORT_INVALID` 400 when a field reference is not in the importer's own describe, with a message naming the offending refs; `SNOWFLAKE_FORBIDDEN`/`QUERY_ERROR` pass through when the describe itself fails (e.g. the view does not exist for this user).

**The security point of this task:** a pasted document is outside input. Field refs in it are re-checked against a live `DESCRIBE` on the importer's own connection, so an import can only ever reference fields that user's Snowflake role can actually see.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_report_import.py`:

```python
import pytest

from app.auth.sessions import SESSION_COOKIE, create_session
from app.snowflake.provider import get_cache
from tests.fakes import FakeConnection
from tests.test_report_routes import valid_definition

DESCRIBE = {
    "tables": [{"name": "A"}, {"name": "C"}],
    "relationships": [],
    "dimensions": [{"table": "C", "name": "REGION", "dataType": "TEXT"}],
    "metrics": [{"table": "A", "name": "REV", "dataType": "NUMBER(38,2)"}],
    "facts": [],
}


@pytest.fixture
def signed_in(client, db, monkeypatch):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    get_cache().put(sess.id, FakeConnection(), rebuildable=False)
    client.cookies.set(SESSION_COOKIE, sess.id)
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: DESCRIBE,
    )
    return sess


def test_import_creates_a_new_report(client, signed_in):
    response = client.post(
        "/api/reports/import", json={"definition": valid_definition()}
    )
    assert response.status_code == 201
    assert response.json()["name"] == "Sales overview"
    assert response.json()["definition"]["visuals"][0]["id"] == "v1"


def test_import_rejects_a_field_the_user_cannot_see(client, signed_in):
    doc = valid_definition()
    doc["visuals"][0]["wells"]["values"] = ["A.SECRET_MARGIN"]
    response = client.post("/api/reports/import", json={"definition": doc})
    assert response.status_code == 400
    assert response.json()["code"] == "REPORT_INVALID"
    assert "A.SECRET_MARGIN" in response.json()["message"]


def test_import_applies_a_view_override(client, signed_in):
    response = client.post(
        "/api/reports/import",
        json={
            "definition": valid_definition(),
            "viewOverride": {"database": "PROD", "schema": "MARTS", "name": "SALES_V2"},
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["view"] == {"database": "PROD", "schema": "MARTS", "name": "SALES_V2"}
    assert body["definition"]["view"]["database"] == "PROD"


def test_import_rejects_an_oversized_body(client, signed_in):
    doc = valid_definition()
    doc["visuals"][0]["title"] = "x" * 70000
    response = client.post("/api/reports/import", json={"definition": doc})
    assert response.status_code in (400, 422)
    assert response.json()["code"] in ("REPORT_INVALID", "VALIDATION_ERROR")


def test_import_always_creates_rather_than_overwrites(client, signed_in):
    first = client.post("/api/reports/import", json={"definition": valid_definition()})
    second = client.post("/api/reports/import", json={"definition": valid_definition()})
    assert first.json()["id"] != second.json()["id"]
    assert len(client.get("/api/reports").json()["reports"]) == 2


def test_import_requires_authentication(client):
    assert client.post(
        "/api/reports/import", json={"definition": valid_definition()}
    ).status_code == 401
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest tests/test_report_import.py -v`
Expected: FAIL — 404 (route missing).

- [ ] **Step 3: Implement the import service**

Append to `backend/app/reports/service.py`:

```python
from app.reports.catalog import wells_to_query
from app.reports.schema import MAX_DEFINITION_BYTES


def _known_refs(detail: dict) -> set[str]:
    """Every field reference this user's role can actually see, upper-cased."""
    refs: set[str] = set()
    for kind in ("dimensions", "metrics", "facts"):
        for field in detail.get(kind, []):
            table = (field.get("table") or "").upper()
            name = (field.get("name") or "").upper()
            refs.add(f"{table}.{name}")
    return refs


def import_report(
    db: Session,
    user_id: uuid.UUID,
    entry,
    cache,
    raw_definition: dict,
    view_override: dict | None = None,
) -> Report:
    """Create a report from an untrusted definition document.

    Every field reference is re-validated against a live DESCRIBE on the
    importing user's own connection, so an imported report can only reference
    fields their Snowflake role can see.
    """
    import json as _json

    if len(_json.dumps(raw_definition)) > MAX_DEFINITION_BYTES:
        raise ApiError(
            "REPORT_INVALID",
            400,
            f"The definition exceeds the {MAX_DEFINITION_BYTES} byte limit",
        )

    if view_override:
        raw_definition = {**raw_definition, "view": view_override}

    definition = parse_definition(raw_definition)

    with entry.lock:
        detail = cache.describe(
            entry,
            definition.view.database,
            definition.view.schema_,
            definition.view.name,
        )

    known = _known_refs(detail)
    missing: list[str] = []
    for visual in definition.visuals:
        dimensions, metrics = wells_to_query(visual.type, visual.wells)
        for ref in dimensions + metrics:
            if ref.upper() not in known:
                missing.append(ref)
    if missing:
        unique = sorted(set(missing))
        raise ApiError(
            "REPORT_INVALID",
            400,
            "This report references fields that do not exist in the target view, "
            "or that your Snowflake role cannot see: " + ", ".join(unique),
        )

    report = Report(owner_user_id=user_id, name=definition.name,
                    view_database="", view_schema="", view_name="", definition={})
    _apply(report, definition)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report
```

- [ ] **Step 4: Implement the route**

Append to `backend/app/reports/routes.py`:

```python
from app.snowflake.provider import get_cache


class ImportBody(BaseModel):
    definition: dict
    viewOverride: dict | None = None


@router.post("/api/reports/import", status_code=201)
def import_report(
    body: ImportBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    cache = get_cache()
    entry = cache.acquire(db, sess)
    report = service.import_report(
        db, sess.user_id, entry, cache, body.definition, body.viewOverride
    )
    return _detail(report)
```

- [ ] **Step 5: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest tests/test_report_import.py -v`
Expected: 6 PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `.venv/Scripts/python.exe -m pytest -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/reports backend/tests/test_report_import.py
git commit -m "feat: import reports from untrusted definition documents"
```

---

### Task 7: Frontend catalog mirror and report API client

**Files:**
- Create: `frontend/src/reports/catalog.ts`, `frontend/src/api/reports.ts`
- Modify: `frontend/src/api/types.ts`
- Test: `frontend/src/reports/catalog.test.ts`

**Interfaces:**
- Consumes: `apiFetch` (sub-project 1).
- Produces:
  - types in `api/types.ts`: `ViewRef {database; schema; name}`, `VisualLayout {x;y;w;h}`, `Visual {id; type: VisualType; title: string; layout: VisualLayout; wells: Record<string,string[]>; options: Record<string, unknown>}`, `CanvasSettings {columns:number; rowHeight:number}`, `ReportDefinition {schemaVersion:number; name:string; view:ViewRef; canvas:CanvasSettings; visuals:Visual[]}`, `ReportSummary {id;name;view:ViewRef;updatedAt:string}`, `ReportDetail = ReportSummary & {definition: ReportDefinition}`.
  - `catalog.ts`: `VisualType = "bar"|"line"|"area"|"pie"|"scatter"|"table"|"kpi"`; `WellSpec {key; label; kind: "dimension"|"metric"; min: number; max: number | null}`; `VisualSpec {type; label; glyph: string; wells: WellSpec[]; options: string[]}`; `CATALOG: Record<VisualType, VisualSpec>`; `wellsToQuery(type, wells): {dimensions: string[]; metrics: string[]}`; `validateWells(type, wells): string[]`; `emptyWellsFor(type): Record<string,string[]>`; `defaultWellFor(type, kind, wells): string | null` (which well a clicked field should go to, or null when every eligible well is full).
  - `api/reports.ts`: `listReports()`, `getReport(id)`, `createReport(definition)`, `updateReport(id, definition)`, `deleteReport(id)`, `exportReport(id): Promise<string>`, `importReport(definition, viewOverride?)`.

`catalog.ts` mirrors `backend/app/reports/catalog.py` exactly. Its test asserts the same expectations as the backend's, so the two cannot drift apart without a red test.

- [ ] **Step 1: Write the failing test**

`frontend/src/reports/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CATALOG,
  defaultWellFor,
  emptyWellsFor,
  validateWells,
  wellsToQuery,
} from "./catalog";

describe("visual catalog", () => {
  it("contains the core seven", () => {
    expect(Object.keys(CATALOG).sort()).toEqual(
      ["area", "bar", "kpi", "line", "pie", "scatter", "table"],
    );
  });

  it("maps bar wells to dimensions then metrics", () => {
    expect(
      wellsToQuery("bar", { axis: ["A.DATE"], legend: ["C.REGION"], values: ["A.REV"] }),
    ).toEqual({ dimensions: ["A.DATE", "C.REGION"], metrics: ["A.REV"] });
  });

  it("puts both scatter axes in metrics", () => {
    expect(
      wellsToQuery("scatter", { x: ["A.REV"], y: ["A.QTY"], detail: ["C.REGION"] }),
    ).toEqual({ dimensions: ["C.REGION"], metrics: ["A.REV", "A.QTY"] });
  });

  it("reports missing and over-full wells", () => {
    expect(validateWells("bar", { axis: [], legend: [], values: ["A.REV"] })[0])
      .toMatch(/Axis/);
    expect(validateWells("pie", { legend: ["C.R"], values: ["A.A", "A.B"] })[0])
      .toMatch(/at most 1/);
    expect(validateWells("table", { dimensions: [], metrics: [] })[0])
      .toMatch(/at least one field/);
  });

  it("refuses the same field in two wells", () => {
    expect(
      validateWells("bar", { axis: ["A.D"], legend: ["A.D"], values: ["A.REV"] })[0],
    ).toMatch(/more than one well/);
  });

  it("builds empty wells for a type", () => {
    expect(emptyWellsFor("pie")).toEqual({ legend: [], values: [] });
  });

  it("routes a clicked field to the first eligible well with room", () => {
    const wells = emptyWellsFor("bar");
    expect(defaultWellFor("bar", "dimension", wells)).toBe("axis");
    expect(defaultWellFor("bar", "metric", wells)).toBe("values");
    const withAxis = { ...wells, axis: ["A.D"] };
    expect(defaultWellFor("bar", "dimension", withAxis)).toBe("legend");
    const full = { axis: ["A.D"], legend: ["A.E"], values: [] };
    expect(defaultWellFor("bar", "dimension", full)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `frontend/`): `npx vitest run src/reports/catalog.test.ts`
Expected: FAIL — cannot resolve `./catalog`.

- [ ] **Step 3: Add the types**

Append to `frontend/src/api/types.ts`:

```ts
export interface ViewRef {
  database: string;
  schema: string;
  name: string;
}

export interface VisualLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Visual {
  id: string;
  type: string;
  title: string;
  layout: VisualLayout;
  wells: Record<string, string[]>;
  options: Record<string, unknown>;
}

export interface CanvasSettings {
  columns: number;
  rowHeight: number;
}

export interface ReportDefinition {
  schemaVersion: number;
  name: string;
  view: ViewRef;
  canvas: CanvasSettings;
  visuals: Visual[];
}

export interface ReportSummary {
  id: string;
  name: string;
  view: ViewRef;
  updatedAt: string;
}

export type ReportDetail = ReportSummary & { definition: ReportDefinition };
```

- [ ] **Step 4: Implement the catalog mirror**

`frontend/src/reports/catalog.ts`:

```ts
// Mirrors backend/app/reports/catalog.py. Both files are covered by tests
// asserting the same rules, so they cannot drift apart silently.

export type VisualType = "bar" | "line" | "area" | "pie" | "scatter" | "table" | "kpi";
export type FieldKind = "dimension" | "metric";

export interface WellSpec {
  key: string;
  label: string;
  kind: FieldKind;
  min: number;
  max: number | null; // null = unbounded
}

export interface VisualSpec {
  type: VisualType;
  label: string;
  glyph: string;
  wells: WellSpec[];
  options: string[];
}

const CATEGORICAL: WellSpec[] = [
  { key: "axis", label: "Axis", kind: "dimension", min: 1, max: 1 },
  { key: "legend", label: "Legend", kind: "dimension", min: 0, max: 1 },
  { key: "values", label: "Values", kind: "metric", min: 1, max: null },
];

export const CATALOG: Record<VisualType, VisualSpec> = {
  bar: { type: "bar", label: "Bar", glyph: "▦", wells: CATEGORICAL, options: ["stacked"] },
  line: { type: "line", label: "Line", glyph: "📈", wells: CATEGORICAL, options: [] },
  area: { type: "area", label: "Area", glyph: "▨", wells: CATEGORICAL, options: ["stacked"] },
  pie: {
    type: "pie", label: "Pie", glyph: "◕",
    wells: [
      { key: "legend", label: "Legend", kind: "dimension", min: 1, max: 1 },
      { key: "values", label: "Values", kind: "metric", min: 1, max: 1 },
    ],
    options: ["donut"],
  },
  scatter: {
    type: "scatter", label: "Scatter", glyph: "⁘",
    wells: [
      { key: "x", label: "X axis", kind: "metric", min: 1, max: 1 },
      { key: "y", label: "Y axis", kind: "metric", min: 1, max: 1 },
      { key: "detail", label: "Detail", kind: "dimension", min: 0, max: 1 },
    ],
    options: [],
  },
  table: {
    type: "table", label: "Table", glyph: "▤",
    wells: [
      { key: "dimensions", label: "Dimensions", kind: "dimension", min: 0, max: null },
      { key: "metrics", label: "Metrics", kind: "metric", min: 0, max: null },
    ],
    options: [],
  },
  kpi: {
    type: "kpi", label: "KPI card", glyph: "Σ",
    wells: [{ key: "value", label: "Value", kind: "metric", min: 1, max: 1 }],
    options: ["format"],
  },
};

export function emptyWellsFor(type: VisualType): Record<string, string[]> {
  return Object.fromEntries(CATALOG[type].wells.map((w) => [w.key, []]));
}

export function wellsToQuery(
  type: VisualType,
  wells: Record<string, string[]>,
): { dimensions: string[]; metrics: string[] } {
  const dimensions: string[] = [];
  const metrics: string[] = [];
  for (const well of CATALOG[type].wells) {
    const target = well.kind === "dimension" ? dimensions : metrics;
    target.push(...(wells[well.key] ?? []));
  }
  return { dimensions, metrics };
}

export function validateWells(
  type: VisualType,
  wells: Record<string, string[]>,
): string[] {
  const spec = CATALOG[type];
  const problems: string[] = [];
  const known = new Set(spec.wells.map((w) => w.key));
  for (const key of Object.keys(wells)) {
    if (!known.has(key)) problems.push(`${spec.label} has no well named "${key}"`);
  }
  const seen = new Map<string, string>();
  for (const well of spec.wells) {
    const refs = wells[well.key] ?? [];
    if (refs.length < well.min) {
      problems.push(`${well.label} needs at least ${well.min} field(s)`);
    }
    if (well.max !== null && refs.length > well.max) {
      problems.push(`${well.label} takes at most ${well.max} field(s)`);
    }
    for (const ref of refs) {
      const existing = seen.get(ref);
      if (existing) {
        problems.push(`${ref} appears in more than one well (${existing} and ${well.label})`);
      } else {
        seen.set(ref, well.label);
      }
    }
  }
  if (type === "table" && seen.size === 0) {
    problems.push("Table needs at least one field");
  }
  return problems;
}

/** Which well a clicked field belongs in, or null when every eligible well is full. */
export function defaultWellFor(
  type: VisualType,
  kind: FieldKind,
  wells: Record<string, string[]>,
): string | null {
  for (const well of CATALOG[type].wells) {
    if (well.kind !== kind) continue;
    const count = (wells[well.key] ?? []).length;
    if (well.max === null || count < well.max) return well.key;
  }
  return null;
}
```

- [ ] **Step 5: Implement the API client**

`frontend/src/api/reports.ts`:

```ts
import { apiFetch } from "./client";
import type { ReportDefinition, ReportDetail, ReportSummary, ViewRef } from "./types";

export function listReports(): Promise<{ reports: ReportSummary[] }> {
  return apiFetch<{ reports: ReportSummary[] }>("/api/reports");
}

export function getReport(id: string): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`);
}

export function createReport(definition: ReportDefinition): Promise<ReportDetail> {
  return apiFetch<ReportDetail>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ definition }),
  });
}

export function updateReport(
  id: string,
  definition: ReportDefinition,
): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ definition }),
  });
}

export function deleteReport(id: string): Promise<void> {
  return apiFetch<void>(`/api/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Returns the raw portable document text, not a parsed object — the point is
 *  to hand the user something byte-identical to copy. */
export async function exportReport(id: string): Promise<string> {
  const response = await fetch(`/api/reports/${encodeURIComponent(id)}/export`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Export failed");
  return response.text();
}

export function importReport(
  definition: unknown,
  viewOverride?: ViewRef,
): Promise<ReportDetail> {
  return apiFetch<ReportDetail>("/api/reports/import", {
    method: "POST",
    body: JSON.stringify({ definition, viewOverride: viewOverride ?? null }),
  });
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/reports/catalog.test.ts` then `npm run typecheck`
Expected: 7 PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/reports/catalog.ts frontend/src/reports/catalog.test.ts frontend/src/api/reports.ts frontend/src/api/types.ts
git commit -m "feat: frontend visual catalog mirror and report api client"
```

---

### Task 8: Routing and the report list page

**Files:**
- Create: `frontend/src/reports/ReportListPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/index.css` (append)
- Test: `frontend/src/reports/ReportListPage.test.tsx`

**Interfaces:**
- Consumes: `listReports`, `deleteReport`, `createReport` (Task 7); `RequireAuth`, `AuthExpiredBridge` (existing App.tsx).
- Produces: routes `/reports` (list, the landing route), `/reports/:id` (builder, added in Task 9), `/explore` (the existing explorer); `/` redirects to `/reports`. `ReportListPage` renders the caller's reports with name, bound view, and updated time; "New report" and per-row Open and Delete.

- [ ] **Step 1: Write the failing test**

`frontend/src/reports/ReportListPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({
  listReports: vi.fn(),
  deleteReport: vi.fn(),
  createReport: vi.fn(),
}));

import { deleteReport, listReports } from "../api/reports";
import ReportListPage from "./ReportListPage";

const listMock = vi.mocked(listReports);
const deleteMock = vi.mocked(deleteReport);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReportListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listMock.mockReset();
  deleteMock.mockReset();
});

describe("ReportListPage", () => {
  it("lists reports with their bound view", async () => {
    listMock.mockResolvedValue({
      reports: [
        {
          id: "r1",
          name: "Sales overview",
          view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
          updatedAt: "2026-08-15T10:00:00+00:00",
        },
      ],
    });
    renderPage();
    expect(await screen.findByText("Sales overview")).toBeInTheDocument();
    expect(screen.getByText(/ANALYTICS\.PUBLIC\.SALES/)).toBeInTheDocument();
  });

  it("invites the user to act when there are no reports", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    expect(await screen.findByText(/no reports yet/i)).toBeInTheDocument();
  });

  it("deletes a report after confirmation", async () => {
    listMock.mockResolvedValue({
      reports: [
        {
          id: "r1",
          name: "Sales overview",
          view: { database: "A", schema: "B", name: "C" },
          updatedAt: "2026-08-15T10:00:00+00:00",
        },
      ],
    });
    deleteMock.mockResolvedValue(undefined);
    renderPage();
    await screen.findByText("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: /delete Sales overview/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("r1"));
  });

  it("surfaces a load failure instead of rendering an empty list", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/reports/ReportListPage.test.tsx`
Expected: FAIL — cannot resolve `./ReportListPage`.

- [ ] **Step 3: Implement the page**

`frontend/src/reports/ReportListPage.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { createReport, deleteReport, listReports } from "../api/reports";
import type { ReportDefinition } from "../api/types";

function blankDefinition(name: string): ReportDefinition {
  return {
    schemaVersion: 1,
    name,
    view: { database: "", schema: "", name: "" },
    canvas: { columns: 12, rowHeight: 40 },
    visuals: [],
  };
}

export default function ReportListPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const reports = useQuery({ queryKey: ["reports"], queryFn: listReports });

  const remove = useMutation({
    mutationFn: (id: string) => deleteReport(id),
    onSuccess: () => {
      setPendingDelete(null);
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
  });

  const create = useMutation({
    mutationFn: () => createReport(blankDefinition("Untitled report")),
    onSuccess: (report) => navigate(`/reports/${report.id}`),
  });

  return (
    <main className="reports">
      <header className="reports-head">
        <h1>Reports</h1>
        <div className="reports-actions">
          <Link className="button secondary" to="/explore">
            Explore
          </Link>
          <button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "Creating..." : "New report"}
          </button>
        </div>
      </header>

      {reports.isLoading && <p>Loading reports...</p>}
      {reports.isError && (
        <p role="alert">
          {reports.error instanceof ApiError
            ? reports.error.message
            : "Could not load your reports."}
        </p>
      )}
      {reports.data?.reports.length === 0 && (
        <p className="empty">No reports yet. Create one to get started.</p>
      )}

      {reports.data && reports.data.reports.length > 0 && (
        <ul className="report-list">
          {reports.data.reports.map((report) => (
            <li key={report.id}>
              <Link className="report-name" to={`/reports/${report.id}`}>
                {report.name}
              </Link>
              <span className="report-view">
                {`${report.view.database}.${report.view.schema}.${report.view.name}`}
              </span>
              <span className="report-updated">
                {new Date(report.updatedAt).toLocaleString()}
              </span>
              <button
                className="link"
                aria-label={`Delete ${report.name}`}
                onClick={() => setPendingDelete(report.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete && (
        <div className="confirm" role="dialog" aria-label="Confirm delete">
          <p>Delete this report? This cannot be undone.</p>
          <button onClick={() => remove.mutate(pendingDelete)}>Delete</button>
          <button className="secondary" onClick={() => setPendingDelete(null)}>
            Cancel
          </button>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Wire the routes**

In `frontend/src/App.tsx`, import `Navigate` (already imported), `ReportListPage`, and `BuilderPage` (Task 9 — add that route in Task 9; for now route `/reports/:id` to `ReportListPage` is NOT acceptable, so add the route only when Task 9 lands). Replace the `<Routes>` block with:

```tsx
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Navigate to="/reports" replace />} />
          <Route
            path="/reports"
            element={
              <RequireAuth>
                <ReportListPage />
              </RequireAuth>
            }
          />
          <Route
            path="/explore"
            element={
              <RequireAuth>
                <ExplorerPage />
              </RequireAuth>
            }
          />
        </Routes>
```

- [ ] **Step 5: Style the list**

Append to `frontend/src/index.css`:

```css
/* ==========================================================================
   Reports list
   ========================================================================== */

.reports {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 16px;
}

.reports-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.reports-head h1 {
  margin: 0;
  font-size: 18px;
  letter-spacing: -0.01em;
}

.reports-actions {
  display: flex;
  gap: 8px;
}

button.secondary,
.button.secondary {
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--axis);
}

.report-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-pane);
  background: var(--surface);
}

.report-list li {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--grid);
}

.report-list li:last-child {
  border-bottom: none;
}

.report-name {
  color: var(--ink);
  text-decoration: none;
  font-weight: 600;
}

.report-name:hover {
  color: var(--accent);
  text-decoration: underline;
}

.report-view {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink-muted);
}

.report-updated {
  font-size: 12px;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}

.reports .empty {
  color: var(--ink-secondary);
}

.confirm {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--grid);
  border-left: 2px solid var(--error);
  border-radius: 4px;
  background: var(--surface);
  display: flex;
  align-items: center;
  gap: 8px;
}

.confirm p {
  margin: 0;
  flex: 1;
  font-size: 13px;
}

@media (max-width: 600px) {
  .report-list li {
    grid-template-columns: 1fr auto;
    row-gap: 4px;
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test` then `npm run typecheck` then `npm run lint`
Expected: all pass. Existing App/Explorer tests that assumed `/` renders the explorer must be updated to use `/explore` — adapt them rather than deleting coverage, and say which you changed in your report.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat: report list page and /reports landing route"
```

---

### Task 9: Visual renderers — option builders per type

**Files:**
- Create: `frontend/src/query/renderers/index.ts`, `frontend/src/query/renderers/categorical.ts`, `frontend/src/query/renderers/pie.ts`, `frontend/src/query/renderers/scatter.ts`
- Test: `frontend/src/query/renderers/renderers.test.ts`

**Interfaces:**
- Consumes: `SERIES_COLORS`, `CHART_INK` from `../palette`; `pivotLegend` from `../pivotLegend`; `QueryResponse` from `../../api/types`; `VisualType`, `wellsToQuery` (Task 7).
- Produces: `buildVisualOption(visual: Visual, result: QueryResponse): EChartsOptionLike | null` — returns an ECharts option for `bar|line|area|pie|scatter`, and `null` for `table` and `kpi` (which render as DOM, not charts). Plus `visualTitle(visual: Visual): string` returning the tile heading: the explicit `title` when set, else a composed one such as `"TOTAL_REVENUE by REGION"`.
- `EChartsOptionLike` is the existing loose option type used by `buildChartOption`; reuse it rather than inventing a second one.

**Colour rule (unchanged and non-negotiable):** every series colour is `SERIES_COLORS[i % 8]` where `i` is the series' stable index — the metric's position in the visual's Values well, or the legend value's position in the pivot. Never the sort rank, never a generated hue. Chrome (axes, grid, labels) uses `CHART_INK`, never a series colour.

- [ ] **Step 1: Write the failing test**

`frontend/src/query/renderers/renderers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { QueryResponse, Visual } from "../../api/types";
import { SERIES_COLORS } from "../palette";
import { buildVisualOption, visualTitle } from "./index";

const categorical: QueryResponse = {
  columns: [
    { name: "REGION", type: "TEXT" },
    { name: "REVENUE", type: "FIXED" },
  ],
  rows: [["EAST", 10], ["WEST", 20]],
  truncated: false,
  sfqid: null,
  sql: "",
};

function visual(over: Partial<Visual>): Visual {
  return {
    id: "v1",
    type: "bar",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["C.REGION"], legend: [], values: ["A.REVENUE"] },
    options: {},
    ...over,
  };
}

describe("buildVisualOption", () => {
  it("builds a bar with the stable first series colour", () => {
    const option = buildVisualOption(visual({}), categorical)!;
    expect(option.series[0].type).toBe("bar");
    expect(option.series[0].itemStyle.color).toBe(SERIES_COLORS[0]);
    expect(option.series[0].itemStyle.borderRadius).toEqual([4, 4, 0, 0]);
  });

  it("stacks bars only when the option says so", () => {
    expect(buildVisualOption(visual({}), categorical)!.series[0].stack).toBeUndefined();
    const stacked = buildVisualOption(
      visual({ options: { stacked: true } }),
      categorical,
    )!;
    expect(stacked.series[0].stack).toBe("total");
  });

  it("builds a line at 2px and an area with a fill", () => {
    const line = buildVisualOption(visual({ type: "line" }), categorical)!;
    expect(line.series[0].type).toBe("line");
    expect(line.series[0].lineStyle.width).toBe(2);
    expect(line.series[0].areaStyle).toBeUndefined();
    const area = buildVisualOption(visual({ type: "area" }), categorical)!;
    expect(area.series[0].areaStyle).toBeDefined();
  });

  it("builds a pie whose slices carry the palette in order", () => {
    const option = buildVisualOption(
      visual({ type: "pie", wells: { legend: ["C.REGION"], values: ["A.REVENUE"] } }),
      categorical,
    )!;
    expect(option.series[0].type).toBe("pie");
    expect(option.series[0].data.map((d: { name: string }) => d.name)).toEqual(["EAST", "WEST"]);
    expect(option.series[0].data[1].itemStyle.color).toBe(SERIES_COLORS[1]);
    expect(option.series[0].radius).toEqual(["0%", "70%"]);
  });

  it("makes a donut when asked", () => {
    const option = buildVisualOption(
      visual({
        type: "pie",
        wells: { legend: ["C.REGION"], values: ["A.REVENUE"] },
        options: { donut: true },
      }),
      categorical,
    )!;
    expect(option.series[0].radius).toEqual(["45%", "70%"]);
  });

  it("builds a scatter with both metrics on value axes", () => {
    const scatterResult: QueryResponse = {
      columns: [
        { name: "REVENUE", type: "FIXED" },
        { name: "QUANTITY", type: "FIXED" },
      ],
      rows: [[10, 1], [20, 2]],
      truncated: false, sfqid: null, sql: "",
    };
    const option = buildVisualOption(
      visual({ type: "scatter", wells: { x: ["A.REVENUE"], y: ["A.QUANTITY"], detail: [] } }),
      scatterResult,
    )!;
    expect(option.series[0].type).toBe("scatter");
    expect(option.xAxis.type).toBe("value");
    expect(option.yAxis.type).toBe("value");
    expect(option.series[0].data).toEqual([[10, 1], [20, 2]]);
    expect(option.series[0].symbolSize).toBeGreaterThanOrEqual(8);
  });

  it("returns null for the DOM-rendered types", () => {
    expect(buildVisualOption(visual({ type: "table" }), categorical)).toBeNull();
    expect(buildVisualOption(visual({ type: "kpi" }), categorical)).toBeNull();
  });

  it("shows a legend only for two or more series", () => {
    const one = buildVisualOption(visual({}), categorical)!;
    expect(one.legend.show).toBe(false);
    const twoMetrics: QueryResponse = {
      columns: [
        { name: "REGION", type: "TEXT" },
        { name: "REVENUE", type: "FIXED" },
        { name: "QUANTITY", type: "FIXED" },
      ],
      rows: [["EAST", 10, 1], ["WEST", 20, 2]],
      truncated: false, sfqid: null, sql: "",
    };
    const two = buildVisualOption(
      visual({ wells: { axis: ["C.REGION"], legend: [], values: ["A.REVENUE", "A.QUANTITY"] } }),
      twoMetrics,
    )!;
    expect(two.legend.show).toBe(true);
  });
});

describe("visualTitle", () => {
  it("prefers an explicit title", () => {
    expect(visualTitle(visual({ title: "My tile" }))).toBe("My tile");
  });

  it("composes one from the wells otherwise", () => {
    expect(visualTitle(visual({}))).toBe("REVENUE by REGION");
    expect(visualTitle(visual({ type: "kpi", wells: { value: ["A.REVENUE"] } })))
      .toBe("REVENUE");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/query/renderers/renderers.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Implement the renderers**

`frontend/src/query/renderers/categorical.ts`:

```ts
import type { QueryResponse, Visual } from "../../api/types";
import { pivotLegend } from "../pivotLegend";
import { CHART_INK, SERIES_COLORS } from "../palette";

export interface Series {
  name: string;
  colorIndex: number;
  data: (number | null)[];
}

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

function columnIndex(result: QueryResponse, name: string): number {
  return result.columns.findIndex((c) => c.name.toUpperCase() === name.toUpperCase());
}

/** Axis categories plus one series per metric (or per legend value). */
export function categoricalSeries(
  visual: Visual,
  result: QueryResponse,
): { categories: string[]; series: Series[] } {
  const axisRef = (visual.wells.axis ?? [])[0];
  const legendRef = (visual.wells.legend ?? [])[0];
  const metricRefs = visual.wells.values ?? [];
  if (!axisRef || metricRefs.length === 0) return { categories: [], series: [] };

  if (legendRef) {
    // A legend splits ONE measure into a series per legend value.
    return pivotLegend(result, fieldName(axisRef), fieldName(legendRef), fieldName(metricRefs[0]));
  }

  const axisIndex = columnIndex(result, fieldName(axisRef));
  if (axisIndex < 0) return { categories: [], series: [] };
  const categories = result.rows.map((row) => String(row[axisIndex] ?? ""));
  const series = metricRefs.flatMap((ref, i) => {
    const index = columnIndex(result, fieldName(ref));
    if (index < 0) return [];
    return [{
      name: fieldName(ref),
      colorIndex: i,
      data: result.rows.map((row) => {
        const value = row[index];
        return value === null || value === undefined ? null : Number(value);
      }),
    }];
  });
  return { categories, series };
}

export const axisChrome = {
  grid: (hasLegend: boolean) => ({
    left: 48, right: 16, top: 16, bottom: hasLegend ? 48 : 28,
  }),
  categoryAxis: (categories: string[]) => ({
    type: "category" as const,
    data: categories,
    axisLine: { lineStyle: { color: CHART_INK.axis } },
    axisLabel: { color: CHART_INK.muted },
    axisTick: { show: false },
  }),
  valueAxis: () => ({
    type: "value" as const,
    splitLine: { lineStyle: { color: CHART_INK.grid } },
    axisLabel: { color: CHART_INK.muted },
  }),
  legend: (count: number) => ({
    show: count > 1,
    bottom: 0,
    textStyle: { color: CHART_INK.secondary },
  }),
  color: (index: number) => SERIES_COLORS[index % SERIES_COLORS.length],
};
```

`frontend/src/query/renderers/pie.ts`:

```ts
import type { QueryResponse, Visual } from "../../api/types";
import { CHART_INK, SERIES_COLORS } from "../palette";

export function pieOption(visual: Visual, result: QueryResponse) {
  const legendRef = (visual.wells.legend ?? [])[0];
  const valueRef = (visual.wells.values ?? [])[0];
  const name = (ref: string) => ref.split(".", 2)[1] ?? ref;
  const idx = (n: string) =>
    result.columns.findIndex((c) => c.name.toUpperCase() === n.toUpperCase());
  const li = legendRef ? idx(name(legendRef)) : -1;
  const vi = valueRef ? idx(name(valueRef)) : -1;
  if (li < 0 || vi < 0) return null;

  const data = result.rows.map((row, i) => ({
    name: String(row[li] ?? ""),
    value: Number(row[vi] ?? 0),
    itemStyle: {
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      borderColor: CHART_INK.surface,
      borderWidth: 2, // the 2px surface gap between adjacent fills
    },
  }));

  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "item" },
    legend: { show: true, bottom: 0, textStyle: { color: CHART_INK.secondary } },
    series: [{
      type: "pie",
      radius: visual.options.donut ? ["45%", "70%"] : ["0%", "70%"],
      center: ["50%", "45%"],
      data,
      label: { color: CHART_INK.secondary },
    }],
  };
}
```

`frontend/src/query/renderers/scatter.ts`:

```ts
import type { QueryResponse, Visual } from "../../api/types";
import { CHART_INK, SERIES_COLORS } from "../palette";

export function scatterOption(visual: Visual, result: QueryResponse) {
  const name = (ref: string) => ref.split(".", 2)[1] ?? ref;
  const idx = (n: string) =>
    result.columns.findIndex((c) => c.name.toUpperCase() === n.toUpperCase());
  const xRef = (visual.wells.x ?? [])[0];
  const yRef = (visual.wells.y ?? [])[0];
  const detailRef = (visual.wells.detail ?? [])[0];
  if (!xRef || !yRef) return null;
  const xi = idx(name(xRef));
  const yi = idx(name(yRef));
  if (xi < 0 || yi < 0) return null;
  const di = detailRef ? idx(name(detailRef)) : -1;

  const groups = new Map<string, [number, number][]>();
  for (const row of result.rows) {
    const key = di >= 0 ? String(row[di] ?? "") : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push([Number(row[xi] ?? 0), Number(row[yi] ?? 0)]);
  }

  const series = [...groups.entries()].map(([key, points], i) => ({
    name: key || name(yRef),
    type: "scatter" as const,
    data: points,
    symbolSize: 9, // the >=8px marker floor
    itemStyle: {
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      borderColor: CHART_INK.surface,
      borderWidth: 1,
    },
  }));

  return {
    backgroundColor: "transparent",
    grid: { left: 56, right: 16, top: 16, bottom: series.length > 1 ? 48 : 28 },
    tooltip: { trigger: "item" },
    legend: { show: series.length > 1, bottom: 0, textStyle: { color: CHART_INK.secondary } },
    xAxis: {
      type: "value",
      name: name(xRef),
      nameTextStyle: { color: CHART_INK.muted },
      splitLine: { lineStyle: { color: CHART_INK.grid } },
      axisLabel: { color: CHART_INK.muted },
    },
    yAxis: {
      type: "value",
      name: name(yRef),
      nameTextStyle: { color: CHART_INK.muted },
      splitLine: { lineStyle: { color: CHART_INK.grid } },
      axisLabel: { color: CHART_INK.muted },
    },
    series,
  };
}
```

`frontend/src/query/renderers/index.ts`:

```ts
import type { QueryResponse, Visual } from "../../api/types";
import type { VisualType } from "../../reports/catalog";
import { axisChrome, categoricalSeries } from "./categorical";
import { pieOption } from "./pie";
import { scatterOption } from "./scatter";

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

/** The tile heading: an explicit title if set, else composed from the wells. */
export function visualTitle(visual: Visual): string {
  if (visual.title) return visual.title;
  const type = visual.type as VisualType;
  if (type === "kpi") return fieldName((visual.wells.value ?? [])[0] ?? "");
  if (type === "scatter") {
    const x = fieldName((visual.wells.x ?? [])[0] ?? "");
    const y = fieldName((visual.wells.y ?? [])[0] ?? "");
    return x && y ? `${y} against ${x}` : "";
  }
  if (type === "pie") {
    const value = fieldName((visual.wells.values ?? [])[0] ?? "");
    const legend = fieldName((visual.wells.legend ?? [])[0] ?? "");
    return value && legend ? `${value} by ${legend}` : value;
  }
  if (type === "table") return "Table";
  const values = (visual.wells.values ?? []).map(fieldName).join(", ");
  const axis = fieldName((visual.wells.axis ?? [])[0] ?? "");
  return axis ? `${values} by ${axis}` : values;
}

/** ECharts option for chart-shaped visuals; null for table and kpi, which are DOM. */
export function buildVisualOption(visual: Visual, result: QueryResponse) {
  const type = visual.type as VisualType;
  if (type === "table" || type === "kpi") return null;
  if (type === "pie") return pieOption(visual, result);
  if (type === "scatter") return scatterOption(visual, result);

  const { categories, series } = categoricalSeries(visual, result);
  if (series.length === 0) return null;
  const stacked = type !== "line" && visual.options.stacked === true;

  return {
    backgroundColor: "transparent",
    grid: axisChrome.grid(series.length > 1),
    tooltip: { trigger: "axis", axisPointer: { type: type === "bar" ? "shadow" : "line" } },
    legend: axisChrome.legend(series.length),
    xAxis: axisChrome.categoryAxis(categories),
    yAxis: axisChrome.valueAxis(),
    series: series.map((s) => {
      const color = axisChrome.color(s.colorIndex);
      if (type === "bar") {
        return {
          name: s.name, type: "bar", data: s.data, barGap: "10%",
          ...(stacked ? { stack: "total" } : {}),
          itemStyle: { color, borderRadius: [4, 4, 0, 0] },
        };
      }
      return {
        name: s.name, type: "line", data: s.data, showSymbol: false,
        ...(stacked ? { stack: "total" } : {}),
        ...(type === "area" ? { areaStyle: { color, opacity: 0.18 } } : {}),
        lineStyle: { width: 2 }, itemStyle: { color },
      };
    }),
  };
}
```

If `buildVisualOption`'s return type needs a name to satisfy `tsc`, reuse the
loose option type `buildChartOption` already declares rather than adding a
second one, and disclose it in your report.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/query/renderers/renderers.test.ts` then `npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/query/renderers
git commit -m "feat: option builders for the core seven visual types"
```

---

### Task 10: VisualTile — per-visual query, render, and error isolation

**Files:**
- Create: `frontend/src/reports/useVisualQuery.ts`, `frontend/src/reports/VisualTile.tsx`
- Modify: `frontend/src/index.css` (append)
- Test: `frontend/src/reports/VisualTile.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (client), `wellsToQuery`, `validateWells`, `CATALOG` (Task 7), `buildVisualOption`, `visualTitle` (Task 9), `AutoChart` (existing), `ResultsTable` (existing), `QueryResponse`/`Visual`/`ViewRef` types.
- Produces: `useVisualQuery(view: ViewRef, visual: Visual)` → TanStack query result of `QueryResponse`, disabled while the visual's wells are invalid; `VisualTile({ visual, view, selected, onSelect })` rendering the tile: heading, body (chart / table / KPI / "needs fields" / error), and a per-tile error boundary in the sense that a failed query renders inside the tile only.

**The isolation rule:** one visual's failure must never blank its neighbours. Each tile owns its own query and its own error state; nothing throws upward.

- [ ] **Step 1: Write the failing test**

`frontend/src/reports/VisualTile.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {
    code: string; status: number; detail?: string | null;
    constructor(code: string, status: number, message: string, detail?: string | null) {
      super(message); this.code = code; this.status = status; this.detail = detail;
    }
  },
}));
vi.mock("./AutoChartAdapter", () => ({ default: () => <div data-testid="chart" /> }));

import { apiFetch, ApiError } from "../api/client";
import type { ViewRef, Visual } from "../api/types";
import VisualTile from "./VisualTile";

const apiFetchMock = vi.mocked(apiFetch);
const view: ViewRef = { database: "A", schema: "B", name: "SALES" };

function visual(over: Partial<Visual> = {}): Visual {
  return {
    id: "v1", type: "bar", title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["C.REGION"], legend: [], values: ["A.REVENUE"] },
    options: {}, ...over,
  };
}

function renderTile(v: Visual) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VisualTile visual={v} view={view} selected={false} onSelect={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

describe("VisualTile", () => {
  it("asks for fields instead of querying when the wells are incomplete", async () => {
    renderTile(visual({ wells: { axis: [], legend: [], values: [] } }));
    expect(await screen.findByText(/needs fields/i)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("renders the composed heading and queries once complete", async () => {
    apiFetchMock.mockResolvedValue({
      columns: [{ name: "REGION", type: "TEXT" }, { name: "REVENUE", type: "FIXED" }],
      rows: [["EAST", 10]], truncated: false, sfqid: null, sql: "",
    });
    renderTile(visual());
    expect(await screen.findByText("REVENUE by REGION")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/query/semantic",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps a failure inside its own tile", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError("SNOWFLAKE_FORBIDDEN", 403, "Insufficient privileges on ORDERS"),
    );
    renderTile(visual());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/insufficient privileges/i);
    // The heading is still there: the tile degraded, it did not disappear.
    expect(screen.getByText("REVENUE by REGION")).toBeInTheDocument();
  });

  it("renders a KPI value as text rather than a chart", async () => {
    apiFetchMock.mockResolvedValue({
      columns: [{ name: "REVENUE", type: "FIXED" }],
      rows: [[1234567]], truncated: false, sfqid: null, sql: "",
    });
    renderTile(visual({ type: "kpi", wells: { value: ["A.REVENUE"] } }));
    expect(await screen.findByTestId("kpi-value")).toHaveTextContent("1,234,567");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/reports/VisualTile.test.tsx`
Expected: FAIL — cannot resolve `./VisualTile`.

- [ ] **Step 3: Implement the query hook**

`frontend/src/reports/useVisualQuery.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { QueryResponse, ViewRef, Visual } from "../api/types";
import { validateWells, wellsToQuery, type VisualType } from "./catalog";

/** One query per visual, so tiles render progressively and one slow visual
 *  cannot block the page. Disabled until the wells are actually valid. */
export function useVisualQuery(view: ViewRef, visual: Visual) {
  const type = visual.type as VisualType;
  const problems = validateWells(type, visual.wells);
  const ready = problems.length === 0 && Boolean(view.name);
  const { dimensions, metrics } = wellsToQuery(type, visual.wells);

  return {
    problems,
    ready,
    query: useQuery({
      queryKey: ["visual-query", view, visual.type, visual.wells],
      enabled: ready,
      queryFn: () =>
        apiFetch<QueryResponse>("/api/query/semantic", {
          method: "POST",
          body: JSON.stringify({
            database: view.database,
            schema: view.schema,
            view: view.name,
            dimensions,
            metrics,
          }),
        }),
    }),
  };
}
```

- [ ] **Step 4: Implement the tile**

Create `frontend/src/reports/AutoChartAdapter.tsx` — a thin wrapper so the tile
can be tested without ECharts touching jsdom:

```tsx
import AutoChart from "../query/AutoChart";

export default AutoChart;
```

`frontend/src/reports/VisualTile.tsx`:

```tsx
import { useMemo } from "react";
import { ApiError } from "../api/client";
import type { QueryResponse, ViewRef, Visual } from "../api/types";
import ResultsTable from "../query/ResultsTable";
import { buildVisualOption, visualTitle } from "../query/renderers";
import AutoChartAdapter from "./AutoChartAdapter";
import { useVisualQuery } from "./useVisualQuery";

interface Props {
  visual: Visual;
  view: ViewRef;
  selected: boolean;
  onSelect: (id: string) => void;
}

function kpiText(result: QueryResponse, format: unknown): string {
  const value = Number(result.rows[0]?.[0] ?? 0);
  if (!Number.isFinite(value)) return "—";
  return format === "compact"
    ? new Intl.NumberFormat(undefined, { notation: "compact" }).format(value)
    : new Intl.NumberFormat().format(value);
}

export default function VisualTile({ visual, view, selected, onSelect }: Props) {
  const { problems, ready, query } = useVisualQuery(view, visual);
  const title = visualTitle(visual);
  const option = useMemo(
    () => (query.data ? buildVisualOption(visual, query.data) : null),
    [visual, query.data],
  );

  let body: React.ReactNode;
  if (!ready) {
    body = <p className="tile-hint">This visual needs fields — {problems[0]}</p>;
  } else if (query.isLoading) {
    body = <p className="tile-hint">Loading…</p>;
  } else if (query.isError) {
    body = (
      <p role="alert" className="tile-error">
        {query.error instanceof ApiError ? query.error.message : "Query failed"}
      </p>
    );
  } else if (query.data) {
    if (visual.type === "kpi") {
      body = (
        <p className="kpi-value" data-testid="kpi-value">
          {kpiText(query.data, visual.options.format)}
        </p>
      );
    } else if (visual.type === "table") {
      body = <ResultsTable result={query.data} />;
    } else if (option) {
      body = <AutoChartAdapter kind="bar" title={title} option={option} />;
    } else {
      body = <p className="tile-hint">Nothing to chart for this field combination.</p>;
    }
  }

  return (
    <section
      className={selected ? "tile selected" : "tile"}
      aria-label={title || "Untitled visual"}
      onMouseDown={() => onSelect(visual.id)}
    >
      <header className="tile-head">
        <h3>{title || "Untitled visual"}</h3>
      </header>
      <div className="tile-body">{body}</div>
    </section>
  );
}
```

**AutoChart change required:** `AutoChart` currently builds its own option from
`kind/categories/series`. Give it an optional `option` prop that, when present,
is used verbatim instead — keeping the existing props working so the explorer is
untouched. Its effect deps become `[option, title]` when `option` is supplied.

- [ ] **Step 5: Style the tile**

Append to `frontend/src/index.css`:

```css
/* ==========================================================================
   Report canvas tiles
   ========================================================================== */

.tile {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-pane);
  overflow: hidden;
}

.tile.selected {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.tile-head {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-bottom: 1px solid var(--grid);
}

.tile-head h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}

.tile-body .auto-chart {
  height: 100%;
  margin: 0;
  border: none;
}

.tile-hint {
  margin: 0;
  color: var(--ink-muted);
  font-size: 12px;
}

.tile-error {
  margin: 0;
  font-size: 12px;
}

.kpi-value {
  margin: 0;
  font-size: 28px;
  font-weight: 600;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat: visual tile with per-tile query and error isolation"
```

---

### Task 11: Canvas grid — drag, resize, and layout persistence

**Files:**
- Create: `frontend/src/reports/CanvasGrid.tsx`
- Modify: `frontend/package.json` (add `react-grid-layout` and `@types/react-grid-layout`), `frontend/src/index.css` (append)
- Test: `frontend/src/reports/CanvasGrid.test.tsx`

**Interfaces:**
- Consumes: `Visual`, `CanvasSettings`, `ViewRef` types; `VisualTile` (Task 10).
- Produces: `CanvasGrid({ visuals, canvas, view, selectedId, onSelect, onLayoutChange, readOnly })`; `onLayoutChange(next: Record<string, VisualLayout>)` fires with every visual's new position after a drag or resize.

**Install:** `npm install react-grid-layout && npm install -D @types/react-grid-layout`. Import its two stylesheets in `CanvasGrid.tsx` (`react-grid-layout/css/styles.css`, `react-resizable/css/styles.css`).

Below 960px the grid renders in `readOnly` mode — tiles stack full width in layout order, and drag handles are suppressed. Dragging to arrange is a desktop affordance; the report still *renders* everywhere.

- [ ] **Step 1: Write the failing test**

`frontend/src/reports/CanvasGrid.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./VisualTile", () => ({
  default: ({ visual }: { visual: { id: string } }) => (
    <div data-testid={`tile-${visual.id}`}>{visual.id}</div>
  ),
}));

import type { Visual } from "../api/types";
import CanvasGrid from "./CanvasGrid";

const visuals: Visual[] = [
  { id: "a", type: "bar", title: "", layout: { x: 0, y: 0, w: 6, h: 6 }, wells: {}, options: {} },
  { id: "b", type: "kpi", title: "", layout: { x: 6, y: 0, w: 3, h: 3 }, wells: {}, options: {} },
];

describe("CanvasGrid", () => {
  it("renders one tile per visual", () => {
    render(
      <CanvasGrid
        visuals={visuals}
        canvas={{ columns: 12, rowHeight: 40 }}
        view={{ database: "A", schema: "B", name: "C" }}
        selectedId={null}
        onSelect={() => {}}
        onLayoutChange={() => {}}
      />,
    );
    expect(screen.getByTestId("tile-a")).toBeInTheDocument();
    expect(screen.getByTestId("tile-b")).toBeInTheDocument();
  });

  it("invites the user to add a visual when the canvas is empty", () => {
    render(
      <CanvasGrid
        visuals={[]}
        canvas={{ columns: 12, rowHeight: 40 }}
        view={{ database: "A", schema: "B", name: "C" }}
        selectedId={null}
        onSelect={() => {}}
        onLayoutChange={() => {}}
      />,
    );
    expect(screen.getByText(/add a visual/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/reports/CanvasGrid.test.tsx`
Expected: FAIL — cannot resolve `./CanvasGrid`.

- [ ] **Step 3: Implement the grid**

`frontend/src/reports/CanvasGrid.tsx`:

```tsx
import GridLayout, { type Layout } from "react-grid-layout";
import { useEffect, useRef, useState } from "react";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { CanvasSettings, ViewRef, Visual, VisualLayout } from "../api/types";
import VisualTile from "./VisualTile";

interface Props {
  visuals: Visual[];
  canvas: CanvasSettings;
  view: ViewRef;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLayoutChange: (next: Record<string, VisualLayout>) => void;
  readOnly?: boolean;
}

/** Width is measured rather than assumed so the grid tracks the pane it sits in. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export default function CanvasGrid({
  visuals, canvas, view, selectedId, onSelect, onLayoutChange, readOnly = false,
}: Props) {
  const { ref, width } = useMeasuredWidth();

  if (visuals.length === 0) {
    return (
      <div className="canvas empty" ref={ref}>
        <p className="tile-hint">Add a visual from the Visualizations pane to begin.</p>
      </div>
    );
  }

  const layout: Layout[] = visuals.map((v) => ({
    i: v.id, x: v.layout.x, y: v.layout.y, w: v.layout.w, h: v.layout.h, minW: 2, minH: 3,
  }));

  return (
    <div className="canvas" ref={ref}>
      <GridLayout
        className="layout"
        layout={layout}
        cols={canvas.columns}
        rowHeight={canvas.rowHeight}
        width={width}
        margin={[12, 12]}
        isDraggable={!readOnly}
        isResizable={!readOnly}
        draggableHandle=".tile-head"
        onLayoutChange={(next) => {
          if (readOnly) return;
          const mapped: Record<string, VisualLayout> = {};
          for (const item of next) {
            mapped[item.i] = { x: item.x, y: item.y, w: item.w, h: item.h };
          }
          onLayoutChange(mapped);
        }}
      >
        {visuals.map((visual) => (
          <div key={visual.id}>
            <VisualTile
              visual={visual}
              view={view}
              selected={selectedId === visual.id}
              onSelect={onSelect}
            />
          </div>
        ))}
      </GridLayout>
    </div>
  );
}
```

Append to `frontend/src/index.css`:

```css
.canvas {
  flex: 1 1 auto;
  min-width: 0;
  overflow: auto;
  padding: 12px;
  background: var(--page);
}

.canvas.empty {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* The tile header doubles as the drag handle; say so on hover. */
.react-grid-item .tile-head {
  cursor: move;
}

.react-grid-item.react-grid-placeholder {
  background: var(--accent);
  opacity: 0.12;
  border-radius: var(--radius-pane);
}

@media (max-width: 959px) {
  /* Stacked reading mode: tiles flow full width in layout order. */
  .canvas .react-grid-layout {
    height: auto !important;
  }
  .canvas .react-grid-item {
    position: static !important;
    width: 100% !important;
    height: auto !important;
    transform: none !important;
    margin-bottom: 12px;
  }
  .canvas .react-grid-item .tile {
    min-height: 260px;
  }
  .react-grid-item .tile-head {
    cursor: default;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test` then `npm run typecheck` then `npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src frontend/package.json frontend/package-lock.json
git commit -m "feat: 12-column snap grid canvas with drag and resize"
```

---

### Task 12: Visualizations pane — type picker and per-type wells

**Files:**
- Create: `frontend/src/reports/VisualPicker.tsx`, `frontend/src/reports/VisualWells.tsx`
- Modify: `frontend/src/index.css` (append)
- Test: `frontend/src/reports/VisualPicker.test.tsx`, `frontend/src/reports/VisualWells.test.tsx`

**Interfaces:**
- Consumes: `CATALOG`, `VisualType`, `emptyWellsFor`, `defaultWellFor`, `validateWells` (Task 7); `FieldInfo`, `Visual` types.
- Produces: `VisualPicker({ value, onChange })` — a grid of type buttons, each a real `<button>` with an accessible name, the current one marked `aria-pressed`; `VisualWells({ visual, onChange })` — the selected visual's wells rendered from its type's spec, with dnd-kit droppables, chip remove buttons, and a keyboard-reachable path.
- `changeVisualType(visual, nextType)` (exported from `VisualPicker.tsx`): returns `{ visual, dropped }` — carries over any well whose key and kind survive in the new type, drops the rest, and reports which were dropped so the UI can say so.

- [ ] **Step 1: Write the failing tests**

`frontend/src/reports/VisualPicker.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Visual } from "../api/types";
import VisualPicker, { changeVisualType } from "./VisualPicker";

const visual: Visual = {
  id: "v1", type: "bar", title: "",
  layout: { x: 0, y: 0, w: 6, h: 6 },
  wells: { axis: ["C.REGION"], legend: [], values: ["A.REV"] },
  options: { stacked: true },
};

describe("VisualPicker", () => {
  it("offers all seven types and marks the current one", async () => {
    const onChange = vi.fn();
    render(<VisualPicker value="bar" onChange={onChange} />);
    expect(screen.getAllByRole("button")).toHaveLength(7);
    expect(screen.getByRole("button", { name: /bar/i })).toHaveAttribute(
      "aria-pressed", "true",
    );
    await userEvent.click(screen.getByRole("button", { name: /pie/i }));
    expect(onChange).toHaveBeenCalledWith("pie");
  });
});

describe("changeVisualType", () => {
  it("keeps wells the new type still has, and reports the rest", () => {
    const { visual: next, dropped } = changeVisualType(visual, "pie");
    // pie has legend + values; axis does not survive.
    expect(next.type).toBe("pie");
    expect(next.wells.values).toEqual(["A.REV"]);
    expect(next.wells.legend).toEqual([]);
    expect(dropped).toContain("Axis");
  });

  it("drops options the new type does not understand", () => {
    const { visual: next } = changeVisualType(visual, "line");
    expect(next.options.stacked).toBeUndefined();
  });

  it("keeps everything when the type is unchanged", () => {
    const { visual: next, dropped } = changeVisualType(visual, "bar");
    expect(next.wells).toEqual(visual.wells);
    expect(dropped).toEqual([]);
  });
});
```

`frontend/src/reports/VisualWells.test.tsx`:

```tsx
import { DndContext } from "@dnd-kit/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Visual } from "../api/types";
import VisualWells from "./VisualWells";

function renderWells(visual: Visual, onChange = vi.fn()) {
  render(
    <DndContext>
      <VisualWells visual={visual} onChange={onChange} />
    </DndContext>,
  );
  return onChange;
}

const bar: Visual = {
  id: "v1", type: "bar", title: "",
  layout: { x: 0, y: 0, w: 6, h: 6 },
  wells: { axis: ["C.REGION"], legend: [], values: ["A.REV"] },
  options: {},
};

describe("VisualWells", () => {
  it("renders the wells its type declares, each as a named region", () => {
    renderWells(bar);
    expect(screen.getByRole("region", { name: "Axis" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Legend" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Values" })).toBeInTheDocument();
  });

  it("renders a different well set for a different type", () => {
    renderWells({ ...bar, type: "scatter", wells: { x: [], y: [], detail: [] } });
    expect(screen.getByRole("region", { name: "X axis" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Y axis" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Axis" })).not.toBeInTheDocument();
  });

  it("removes a field through its own button", async () => {
    const onChange = renderWells(bar);
    await userEvent.click(screen.getByRole("button", { name: /remove C\.REGION/i }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ wells: expect.objectContaining({ axis: [] }) }),
    );
  });

  it("states what each empty well accepts", () => {
    renderWells({ ...bar, wells: { axis: [], legend: [], values: [] } });
    expect(screen.getAllByText(/drop a field here/i).length).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/reports/VisualPicker.test.tsx src/reports/VisualWells.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the picker**

`frontend/src/reports/VisualPicker.tsx`:

```tsx
import type { Visual } from "../api/types";
import { CATALOG, type VisualType } from "./catalog";

interface Props {
  value: VisualType;
  onChange: (next: VisualType) => void;
}

export default function VisualPicker({ value, onChange }: Props) {
  return (
    <div className="visual-picker" role="group" aria-label="Visual type">
      {(Object.keys(CATALOG) as VisualType[]).map((type) => {
        const spec = CATALOG[type];
        return (
          <button
            key={type}
            type="button"
            className={type === value ? "picker-item selected" : "picker-item"}
            aria-pressed={type === value}
            aria-label={spec.label}
            title={spec.label}
            onClick={() => onChange(type)}
          >
            <span aria-hidden="true">{spec.glyph}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Switch a visual's type, carrying over what the new type can still hold.
 *  Returns the labels of any wells that had to be dropped so the UI can say so. */
export function changeVisualType(
  visual: Visual,
  nextType: VisualType,
): { visual: Visual; dropped: string[] } {
  if (visual.type === nextType) return { visual, dropped: [] };
  const from = CATALOG[visual.type as VisualType];
  const to = CATALOG[nextType];

  const wells: Record<string, string[]> = {};
  for (const well of to.wells) wells[well.key] = [];

  const dropped: string[] = [];
  for (const well of from.wells) {
    const refs = visual.wells[well.key] ?? [];
    if (refs.length === 0) continue;
    const target = to.wells.find((w) => w.key === well.key && w.kind === well.kind);
    if (!target) {
      dropped.push(well.label);
      continue;
    }
    wells[target.key] = target.max === null ? refs : refs.slice(0, target.max);
    if (target.max !== null && refs.length > target.max) dropped.push(well.label);
  }

  const options = Object.fromEntries(
    Object.entries(visual.options).filter(([key]) => to.options.includes(key)),
  );

  return { visual: { ...visual, type: nextType, wells, options }, dropped };
}
```

- [ ] **Step 4: Implement the wells pane**

`frontend/src/reports/VisualWells.tsx`:

```tsx
import { useDroppable } from "@dnd-kit/core";
import type { Visual } from "../api/types";
import { CATALOG, type FieldKind, type VisualType, type WellSpec } from "./catalog";

interface Props {
  visual: Visual;
  onChange: (next: Visual) => void;
}

function Well({
  spec, refs, onRemove,
}: { spec: WellSpec; refs: string[]; onRemove: (ref: string) => void }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `well:${spec.key}` });
  const draggedKind = active?.data.current?.kind as FieldKind | undefined;
  const accepts = draggedKind === undefined || draggedKind === spec.kind;
  const full = spec.max !== null && refs.length >= spec.max;
  const state = !active ? "" : accepts && !full ? (isOver ? "over" : "eligible") : "blocked";

  return (
    <section ref={setNodeRef} role="region" aria-label={spec.label}
             className="well" data-state={state}>
      <div className="well-head">
        <h4>{spec.label}</h4>
        <span className="well-type">
          {spec.kind === "metric" ? "Σ metric" : "⬦ dimension"}
        </span>
      </div>
      {refs.length === 0 ? (
        <p className="well-hint">Drop a field here</p>
      ) : (
        refs.map((ref) => (
          <span className="chip" key={ref} data-kind={spec.kind}>
            <span className="chip-glyph">{spec.kind === "metric" ? "Σ" : "⬦"}</span>
            <span className="chip-label">{ref}</span>
            <button type="button" className="chip-remove"
                    aria-label={`Remove ${ref}`} onClick={() => onRemove(ref)}>
              &times;
            </button>
          </span>
        ))
      )}
    </section>
  );
}

export default function VisualWells({ visual, onChange }: Props) {
  const spec = CATALOG[visual.type as VisualType];
  return (
    <div className="visual-wells">
      {spec.wells.map((well) => (
        <Well
          key={well.key}
          spec={well}
          refs={visual.wells[well.key] ?? []}
          onRemove={(ref) =>
            onChange({
              ...visual,
              wells: {
                ...visual.wells,
                [well.key]: (visual.wells[well.key] ?? []).filter((r) => r !== ref),
              },
            })
          }
        />
      ))}
    </div>
  );
}
```

Append to `frontend/src/index.css`:

```css
.visual-picker {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  margin-bottom: 8px;
}

.picker-item {
  background: var(--surface);
  color: var(--ink-secondary);
  border: 1px solid var(--axis);
  min-height: 28px;
  font-size: 14px;
  padding: 2px;
}

.picker-item.selected {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-wash);
}

.visual-wells {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat: visual type picker and per-type wells pane"
```

---

### Task 13: Builder page — shell, fields pane, drag wiring, save

**Files:**
- Create: `frontend/src/reports/BuilderPage.tsx`
- Modify: `frontend/src/App.tsx` (add the `/reports/:id` route), `frontend/src/index.css` (append)
- Test: `frontend/src/reports/BuilderPage.test.tsx`

**Interfaces:**
- Consumes: `getReport`, `updateReport` (Task 7); `CanvasGrid` (Task 11); `VisualPicker`/`changeVisualType`, `VisualWells` (Task 12); `useFieldSensors` and `FieldPanel` patterns from the explorer; `CATALOG`, `emptyWellsFor`, `defaultWellFor`.
- Produces: the `/reports/:id` route rendering the PowerBI-shaped builder: canvas centre-left; Visualizations pane (picker + wells) above a Fields pane on the right; header with the report name, Save, Export, Import; `Add visual` creating a new tile at the first free row.

Behaviour required:
- Selecting a tile populates the wells; with no selection the pane says so.
- Clicking a field adds it to the selected visual's default well (`defaultWellFor`); dragging it onto a well places it there. Drag is never the only path.
- The report is dirty after any change; Save is enabled only when dirty and re-saves the whole definition.
- Changing type reports any dropped wells in a notice.
- If the report has no bound view yet (a fresh report), the builder first asks the user to pick a semantic view, reusing the existing view tree.
- **Refresh fields.** A button in the Fields pane header re-fetches the view description with `?refresh=true`, bypassing the per-session describe cache from Task 4, then invalidates the visual queries so tiles re-run. This is how a user picks up a semantic model change without waiting out the 300s TTL or restarting.
- **A bound view that has since disappeared** must not leave the builder blank. When the describe call for the report's view fails with 404 / `SNOWFLAKE_FORBIDDEN` / `QUERY_ERROR`, show a report-level message naming the view and offering to bind to another one, reusing the same view tree as the fresh-report case. The user's visuals stay in the working copy so rebinding to an equivalent view keeps their layout.

- [ ] **Step 1: Write the failing test**

`frontend/src/reports/BuilderPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({
  getReport: vi.fn(), updateReport: vi.fn(), exportReport: vi.fn(), importReport: vi.fn(),
}));
vi.mock("../api/client", () => ({
  apiFetch: vi.fn().mockResolvedValue({ columns: [], rows: [], truncated: false, sfqid: null, sql: "" }),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {},
}));
vi.mock("./CanvasGrid", () => ({
  default: ({ visuals, onSelect }: { visuals: { id: string }[]; onSelect: (id: string) => void }) => (
    <div>
      {visuals.map((v) => (
        <button key={v.id} onClick={() => onSelect(v.id)}>{`select ${v.id}`}</button>
      ))}
    </div>
  ),
}));

import { getReport, updateReport } from "../api/reports";
import BuilderPage from "./BuilderPage";

const getMock = vi.mocked(getReport);
const updateMock = vi.mocked(updateReport);

const detail = {
  id: "r1",
  name: "Sales overview",
  view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
  updatedAt: "2026-08-15T10:00:00+00:00",
  definition: {
    schemaVersion: 1,
    name: "Sales overview",
    view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
    canvas: { columns: 12, rowHeight: 40 },
    visuals: [
      {
        id: "v1", type: "bar", title: "",
        layout: { x: 0, y: 0, w: 6, h: 6 },
        wells: { axis: ["C.REGION"], legend: [], values: ["A.REV"] },
        options: {},
      },
    ],
  },
};

function renderBuilder() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/reports/r1"]}>
        <Routes>
          <Route path="/reports/:id" element={<BuilderPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  updateMock.mockReset();
  getMock.mockResolvedValue(detail);
});

describe("BuilderPage", () => {
  it("shows the report name and both panes", async () => {
    renderBuilder();
    expect(await screen.findByDisplayValue("Sales overview")).toBeInTheDocument();
    expect(screen.getByText(/visualizations/i)).toBeInTheDocument();
    expect(screen.getByText(/^fields$/i)).toBeInTheDocument();
  });

  it("asks the user to pick a visual before showing wells", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByText(/select a visual/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    expect(await screen.findByRole("region", { name: "Axis" })).toBeInTheDocument();
  });

  it("keeps Save disabled until something changes, then saves the definition", async () => {
    updateMock.mockResolvedValue(detail);
    renderBuilder();
    const save = await screen.findByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    await userEvent.click(screen.getByRole("button", { name: /remove C\.REGION/i }));
    expect(await screen.findByRole("button", { name: /^save$/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, savedDefinition] = updateMock.mock.calls[0];
    expect(savedDefinition.visuals[0].wells.axis).toEqual([]);
  });

  it("offers to rebind when the bound view no longer resolves", async () => {
    // The describe call is the /api/semantic-views/... fetch made through
    // apiFetch; make it reject and assert the builder explains rather than
    // rendering an empty canvas.
    const { apiFetch } = await import("../api/client");
    vi.mocked(apiFetch).mockRejectedValueOnce(
      Object.assign(new Error("Semantic view not found"), {
        code: "QUERY_ERROR", status: 400,
      }),
    );
    renderBuilder();
    expect(await screen.findByText(/ANALYTICS\.PUBLIC\.SALES/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose another view/i })).toBeInTheDocument();
  });

  it("reports wells dropped by a type change", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    await userEvent.click(screen.getByRole("button", { name: /^pie$/i }));
    expect(await screen.findByText(/axis/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/reports/BuilderPage.test.tsx`
Expected: FAIL — cannot resolve `./BuilderPage`.

- [ ] **Step 3: Implement the builder**

`frontend/src/reports/BuilderPage.tsx` — structure to build (write the full
component; the pieces below are the parts that carry real logic):

```tsx
// State: `definition` (working copy), `savedJson` (the last persisted
// serialisation, for dirty comparison), `selectedId`, `notice`.
const dirty = JSON.stringify(definition) !== savedJson;

// Adding a visual: place it on the first free row so it never lands on top
// of an existing tile.
function addVisual(type: VisualType) {
  const nextY = definition.visuals.reduce(
    (max, v) => Math.max(max, v.layout.y + v.layout.h), 0,
  );
  const visual: Visual = {
    id: `v${crypto.randomUUID().slice(0, 8)}`,
    type,
    title: "",
    layout: { x: 0, y: nextY, w: 6, h: 6 },
    wells: emptyWellsFor(type),
    options: {},
  };
  setDefinition({ ...definition, visuals: [...definition.visuals, visual] });
  setSelectedId(visual.id);
}

// Clicking a field in the Fields pane — the non-drag path, which must always
// exist. Routes to the selected visual's first eligible well with room.
function addFieldToSelected(ref: string, kind: FieldKind) {
  const visual = definition.visuals.find((v) => v.id === selectedId);
  if (!visual) return;
  const wellKey = defaultWellFor(visual.type as VisualType, kind, visual.wells);
  if (!wellKey) {
    setNotice(`Every ${kind} well on this visual is full.`);
    return;
  }
  replaceVisual({
    ...visual,
    wells: { ...visual.wells, [wellKey]: [...(visual.wells[wellKey] ?? []), ref] },
  });
}

// Dropping onto a specific well (dnd-kit onDragEnd). The droppable ids are
// "well:<key>", set by VisualWells.
function onDragEnd(event: DragEndEvent) {
  const visual = definition.visuals.find((v) => v.id === selectedId);
  const overId = String(event.over?.id ?? "");
  const data = event.active.data.current as { ref: string; kind: FieldKind } | undefined;
  if (!visual || !data || !overId.startsWith("well:")) return;
  const key = overId.slice("well:".length);
  const spec = CATALOG[visual.type as VisualType].wells.find((w) => w.key === key);
  if (!spec || spec.kind !== data.kind) return;                    // wrong kind: refuse
  const current = visual.wells[key] ?? [];
  if (current.includes(data.ref)) return;                          // already there
  if (Object.values(visual.wells).some((refs) => refs.includes(data.ref))) return; // another well
  const next = spec.max === 1 ? [data.ref] : [...current, data.ref];
  replaceVisual({ ...visual, wells: { ...visual.wells, [key]: next } });
}

// Type change, surfacing what could not be carried over.
function onTypeChange(nextType: VisualType) {
  const visual = definition.visuals.find((v) => v.id === selectedId);
  if (!visual) return;
  const { visual: updated, dropped } = changeVisualType(visual, nextType);
  replaceVisual(updated);
  setNotice(dropped.length ? `Cleared on type change: ${dropped.join(", ")}.` : null);
}

// Save persists the whole definition, then re-baselines the dirty comparison.
const save = useMutation({
  mutationFn: () => updateReport(reportId, definition),
  onSuccess: (saved) => {
    setSavedJson(JSON.stringify(saved.definition));
    queryClient.invalidateQueries({ queryKey: ["reports"] });
  },
});
```

Layout (JSX skeleton):

```tsx
<div className="builder">
  <header className="builder-head">
    <input aria-label="Report name" value={definition.name}
           onChange={(e) => setDefinition({ ...definition, name: e.target.value })} />
    <div className="builder-actions">
      <button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
        {save.isPending ? "Saving…" : "Save"}
      </button>
      <button className="secondary" onClick={() => setPanel("export")}>Export</button>
      <button className="secondary" onClick={() => setPanel("import")}>Import</button>
    </div>
  </header>
  {notice && <p className="notice">{notice}</p>}
  <DndContext sensors={sensors} onDragEnd={onDragEnd}>
    <div className="builder-body">
      <CanvasGrid ... />
      <aside className="builder-panes">
        <section>
          <h3>Visualizations</h3>
          <VisualPicker value={selectedType} onChange={onTypeChange} />
          <button className="secondary" onClick={() => addVisual(selectedType)}>
            Add visual
          </button>
          {selected
            ? <VisualWells visual={selected} onChange={replaceVisual} />
            : <p className="tile-hint">Select a visual on the canvas to edit its fields.</p>}
        </section>
        <section>
          <h3>Fields</h3>
          {/* dimensions then metrics, each a draggable + clickable button,
              exactly as the explorer's FieldPanel does */}
        </section>
      </aside>
    </div>
  </DndContext>
</div>
```

Add the route in `App.tsx`:

```tsx
          <Route
            path="/reports/:id"
            element={
              <RequireAuth>
                <BuilderPage />
              </RequireAuth>
            }
          />
```

Append the builder layout CSS (right-hand panes, canvas fills the rest, and a
stacked arrangement under 960px matching the explorer's approach):

```css
.builder { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.builder-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex: 0 0 auto; padding: 8px 16px;
  background: var(--surface); border-bottom: 1px solid var(--border);
}
.builder-head input { font-size: 14px; font-weight: 600; min-width: 0; flex: 1 1 auto; }
.builder-actions { display: flex; gap: 8px; flex: 0 0 auto; }
.builder-body { display: flex; flex: 1; min-height: 0; }
.builder-panes {
  flex: 0 0 var(--pane-wells); overflow-y: auto; padding: var(--pane-padding);
  border-left: 1px solid var(--border); background: var(--surface);
}
.builder-panes h3 {
  margin: 0 0 8px; font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--ink-muted);
}
.builder-panes section + section { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--grid); }
@media (max-width: 1279px) { .builder-panes { flex-basis: 200px; } }
@media (max-width: 959px) {
  .builder-body { flex-direction: column; }
  .builder-panes { flex: 0 0 auto; border-left: none; border-top: 1px solid var(--border); }
  .builder { height: auto; overflow: visible; }
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npm test` then `npm run typecheck` then `npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: report builder shell with canvas, panes and save"
```

---

### Task 14: Export and Import panels

**Files:**
- Create: `frontend/src/reports/ExportPanel.tsx`, `frontend/src/reports/ImportPanel.tsx`
- Modify: `frontend/src/reports/BuilderPage.tsx`, `frontend/src/reports/ReportListPage.tsx` (Import entry point), `frontend/src/index.css`
- Test: `frontend/src/reports/ExportPanel.test.tsx`, `frontend/src/reports/ImportPanel.test.tsx`

**Interfaces:**
- Consumes: `exportReport`, `importReport` (Task 7); `ApiError`.
- Produces: `ExportPanel({ reportId, onClose })` — fetches the portable document, shows it in a read-only `<textarea>` (so it can be selected and copied even where the clipboard API is blocked), plus a Copy button using `navigator.clipboard` with a visible fallback message when unavailable; `ImportPanel({ onImported, onClose })` — a paste box, an optional view override (database / schema / view inputs), an Import button, and inline error display that shows the backend's `REPORT_INVALID` message verbatim, since that message names the offending fields.

- [ ] **Step 1: Write the failing tests**

`frontend/src/reports/ExportPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({ exportReport: vi.fn() }));
import { exportReport } from "../api/reports";
import ExportPanel from "./ExportPanel";

const exportMock = vi.mocked(exportReport);

describe("ExportPanel", () => {
  it("shows the document verbatim in a selectable, read-only box", async () => {
    exportMock.mockResolvedValue('{\n  "schemaVersion": 1\n}\n');
    render(<ExportPanel reportId="r1" onClose={() => {}} />);
    const box = await screen.findByLabelText(/report definition/i);
    await waitFor(() => expect(box).toHaveValue('{\n  "schemaVersion": 1\n}\n'));
    expect(box).toHaveAttribute("readonly");
  });

  it("surfaces a failure rather than showing an empty box", async () => {
    exportMock.mockRejectedValue(new Error("nope"));
    render(<ExportPanel reportId="r1" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
```

`frontend/src/reports/ImportPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({ importReport: vi.fn() }));
vi.mock("../api/client", () => ({
  ApiError: class extends Error {
    code: string; status: number; detail?: string | null;
    constructor(code: string, status: number, message: string) {
      super(message); this.code = code; this.status = status;
    }
  },
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
}));

import { ApiError } from "../api/client";
import { importReport } from "../api/reports";
import ImportPanel from "./ImportPanel";

const importMock = vi.mocked(importReport);

describe("ImportPanel", () => {
  it("rejects text that is not JSON before calling the server", async () => {
    render(<ImportPanel onImported={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText(/paste a report definition/i), "not json");
    await userEvent.click(screen.getByRole("button", { name: /^import$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid json/i);
    expect(importMock).not.toHaveBeenCalled();
  });

  it("passes a view override when one is supplied", async () => {
    importMock.mockResolvedValue({
      id: "r2", name: "Imported", view: { database: "P", schema: "M", name: "V" },
      updatedAt: "", definition: {} as never,
    });
    const onImported = vi.fn();
    render(<ImportPanel onImported={onImported} onClose={() => {}} />);
    await userEvent.type(
      screen.getByLabelText(/paste a report definition/i), '{"schemaVersion":1}',
    );
    await userEvent.type(screen.getByLabelText(/database/i), "P");
    await userEvent.type(screen.getByLabelText(/schema/i), "M");
    await userEvent.type(screen.getByLabelText(/^view$/i), "V");
    await userEvent.click(screen.getByRole("button", { name: /^import$/i }));
    await waitFor(() =>
      expect(importMock).toHaveBeenCalledWith(
        { schemaVersion: 1 }, { database: "P", schema: "M", name: "V" },
      ),
    );
    expect(onImported).toHaveBeenCalled();
  });

  it("shows the backend's reason verbatim, since it names the bad fields", async () => {
    importMock.mockRejectedValue(
      new ApiError(
        "REPORT_INVALID", 400,
        "This report references fields that do not exist in the target view, or that your Snowflake role cannot see: A.SECRET",
      ),
    );
    render(<ImportPanel onImported={() => {}} onClose={() => {}} />);
    await userEvent.type(
      screen.getByLabelText(/paste a report definition/i), '{"schemaVersion":1}',
    );
    await userEvent.click(screen.getByRole("button", { name: /^import$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/A\.SECRET/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/reports/ExportPanel.test.tsx src/reports/ImportPanel.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement both panels**

These two are specified in prose rather than as full listings because they are
plain forms with no non-obvious logic; every label, message, condition and
call is named exactly, and the tests above pin all of it. Match the wording
given — the tests query by these strings.

`ExportPanel.tsx`: a `useQuery` on `exportReport(reportId)`; render a
`<label>Report definition<textarea readOnly value={data} /></label>`, a Copy
button calling `navigator.clipboard.writeText` inside a try/catch that sets a
"Copy is unavailable in this browser — select the text and copy manually."
message on failure, an error paragraph with `role="alert"` when the query
fails, and a Close button.

`ImportPanel.tsx`: a `<label>Paste a report definition<textarea /></label>`,
three optional inputs labelled Database, Schema and View, and an Import button.
On submit: `JSON.parse` inside a try/catch, setting the error "That is not
valid JSON." without calling the server when it throws; otherwise call
`importReport(parsed, override)` where `override` is supplied only when all
three inputs are non-empty. On success call `onImported(report)`. On failure
show `err instanceof ApiError ? err.message : "Import failed"` in a
`role="alert"` paragraph.

Wire both into `BuilderPage` (the `panel` state from Task 13) and add an
"Import" button to `ReportListPage`'s header that opens `ImportPanel` and
navigates to the new report on success.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npm test` then `npm run typecheck` then `npm run lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: export and import panels for portable report definitions"
```

---

### Task 15: Explorer hand-off, integration test, docs, and a look at the real thing

**Files:**
- Modify: `frontend/src/explorer/ExplorerPage.tsx` (Add to report), `README.md`
- Create: `backend/tests/integration/test_reports_it.py`
- Test: the above plus a manual pass

**Interfaces:**
- Consumes: `createReport` (Task 7); the explorer's existing `wells` state.
- Produces: an "Add to report" action in the explorer that creates a new report from the current view and wells and navigates to its builder; an env-gated integration test covering a report round trip against a real semantic view; README coverage of reports, export and import.

- [ ] **Step 1: Add the explorer hand-off with a test**

Add to `frontend/src/explorer/ExplorerPage.test.tsx` a test asserting that
clicking "Add to report" calls `createReport` with a definition whose single
visual carries the explorer's current wells, then implement it in
`ExplorerPage.tsx`: build a `ReportDefinition` with one `bar` visual at
`{x:0,y:0,w:6,h:6}` holding the current wells, `createReport` it, and
`navigate` to `/reports/{id}`. The button is disabled until a view is selected
and at least one field is placed.

- [ ] **Step 2: Write the integration test**

`backend/tests/integration/test_reports_it.py` — same env gating as the existing
suite (`SEMANTICUI_IT_*`, skipped when unset). Sign in with the connector
directly, then exercise the service layer against the real account: describe the
configured view, build a definition whose wells use the first real dimension and
metric found, `import_report` it, and assert the created report's definition
round-trips through `to_export_document` unchanged. This is the test that would
catch a describe-shape change breaking import.

- [ ] **Step 3: Run the suites**

Run (backend): `.venv/Scripts/python.exe -m pytest -q` and
`.venv/Scripts/python.exe -m pytest -m integration -v` (expect skips without credentials).
Run (frontend): `npm test`, `npm run typecheck`, `npm run lint`.
Expected: all pass; integration skips cleanly.

- [ ] **Step 4: Update the README**

Add a "Reports" section covering: creating a report, binding it to a semantic
view, adding visuals and choosing types, the seven types and what each well
takes, saving, and export/import including the view override. State plainly that
report definitions are stored but query results never are, and that a shared or
imported report always runs on the *viewer's* own Snowflake credentials.
Extend the manual smoke checklist with a report round trip: create, add two
visuals of different types, drag one, save, reload, export, import the copy,
confirm the imported report renders identically.

- [ ] **Step 5: Look at the running app — not optional**

With both servers running, load the builder and check: tiles drag and snap;
resizing re-renders the chart at the new size; a tile whose field the role
cannot see shows its error while neighbours keep their data; the type picker
switches a visual in place; Save enables only when dirty; Export shows JSON you
can select; Import round-trips that JSON into a second report. Then check
1440 / 1024 / 768 / 390px for horizontal overflow and confirm the builder
stacks below 960px. Fix what you find before committing, and describe what you
saw.

- [ ] **Step 6: Commit**

```bash
git add frontend/src backend/tests/integration README.md
git commit -m "feat: explorer hand-off, report integration test, and docs"
```

---

## Done

All 15 tasks complete = sub-project 2a is shippable: a report canvas with the
core seven visual types, saved reports owned per user, and portable JSON
export/import that re-validates every field reference against the importing
user's own Snowflake role.

Sub-project 2b (filters, hierarchies, drill-down, cross-filtering) builds on
the `definition` document, which absorbs new keys without a migration. Sub-project
3 (workspaces & sharing) builds on `reports.owner_user_id` and on the property
this plan preserves throughout: nothing renders without the viewer's own
credentials.
