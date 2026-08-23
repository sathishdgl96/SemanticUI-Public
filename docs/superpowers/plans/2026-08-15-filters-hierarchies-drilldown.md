# Filters, Hierarchies & Drill-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give saved reports analytical depth — filters at report and visual scope, hierarchies you can drill through, and click-to-cross-filter between visuals — without ever putting a user-supplied value into SQL text.

**Architecture:** Filters are the primitive. A filter is a `{field, op, values}` record in the report definition document; the backend turns it into a predicate string with `?` placeholders plus an ordered parameter list, and the Snowflake cursor binds the values. Drill-down is a hierarchy reference in an axis well plus an ephemeral client-side path that resolves to "the field at this level" and contributes one `is` filter per level already traversed. Cross-filtering is a transient filter produced by a chart click, held in React state and never persisted.

**Tech Stack:** FastAPI + pydantic v2 + SQLAlchemy 2.0 (backend), React 18 + TypeScript + TanStack Query + ECharts + dnd-kit (frontend), snowflake-connector-python, pytest, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-15-filters-hierarchies-drilldown-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **Values are bound parameters, never SQL text.** No filter value is ever concatenated, interpolated, quoted-and-embedded, or f-stringed into a statement.
- **Field references keep the existing path** — resolved against the describe catalog, emitted as `quote_ident` output, never taken from user text.
- **Operators come from a closed enum.** An unrecognised operator is a `REPORT_INVALID` rejection, not a passthrough.
- **Relative dates are resolved server-side** into bound dates. No date arithmetic is assembled from user input as text.
- **Value counts and lengths are bounded**: at most **500 values per filter**, each at most **255 characters**.
- **Cross-filter selections are subject to every rule above.**
- Drill position and cross-filter selection are **ephemeral** — React state only, never written to the definition document.
- `SCHEMA_VERSION` becomes **2**; v1 documents stay readable forever through `migrate_definition`; anything above the current version is still rejected.
- Existing UI constraints carry over: drag is never the only path, focus outlines are never removed, hit targets clear 24px, chrome is never painted in a series colour, and the layout holds at 1440 / 1280 / 1024 / 768 / 390px.
- **Never modify or reorder `frontend/src/query/palette.ts`.** Its eight hexes are a validated colourblind-safe sequence.
- Existing limits still apply: `MAX_VISUALS = 50`, `MAX_DEFINITION_BYTES = 65536`, `MAX_REF_LENGTH = 511`, `MAX_REFS_PER_WELL = 50`.
- Backend endpoints are sync `def` (not `async def`), matching every existing route.

## File Structure

**Backend — created:**
- `app/reports/filters.py` — the filter pydantic models and the closed operator enum. Definition-document side only; knows nothing about SQL.
- `app/reports/migrate.py` — `migrate_definition`, the v1→v2 upgrade, run before validation.
- `app/semantic/predicates.py` — filters → `(predicate_sql_fragments, params)`, plus server-side relative-date resolution. The only file that turns a filter into SQL.

**Backend — modified:**
- `app/reports/schema.py` — `SCHEMA_VERSION = 2`, `filters` / `hierarchies` on the document, `filters` on each visual, hierarchy-reference validation, calls `migrate_definition`.
- `app/reports/catalog.py` — `wells_to_query` learns to expand a `hierarchy:` reference into all its levels (for validation).
- `app/semantic/query.py` — `SemanticQueryRequest.filters`; `build_semantic_sql` returns params.
- `app/snowflake/gateway.py` — `run_query` binds params.
- `app/snowflake/connect.py` — connections open with the paramstyle the spike selected.
- `app/semantic/routes.py` — threads params through; adds the distinct-values endpoint.
- `tests/fakes.py` — `FakeCursor.execute` accepts and records bound params.

**Frontend — created:**
- `src/reports/filters.ts` — filter/hierarchy/drill types and the pure functions that compose them. No React.
- `src/reports/FilterPane.tsx` — the report/visual filter list.
- `src/reports/FilterEditor.tsx` — one filter's editor.
- `src/reports/useFieldValues.ts` — distinct values for the editor.
- `src/reports/HierarchyPane.tsx` — define and edit hierarchies.

**Frontend — modified:**
- `src/api/types.ts`, `src/reports/catalog.ts`, `src/reports/useVisualQuery.ts`, `src/reports/VisualTile.tsx`, `src/reports/CanvasGrid.tsx`, `src/reports/BuilderPage.tsx`, `src/index.css`.

---

## Task 1: Spike — does `SEMANTIC_VIEW()` accept `WHERE` with bind parameters?

**This task gates every task after it. If any answer differs from the assumption below, STOP, write the findings file, and report to the user. Do not start Task 2.**

Everything in this plan assumes Snowflake's `SEMANTIC_VIEW(...)` table function accepts a `WHERE` clause and that bind parameters work inside it. That is unverified. Filters must be pushed *inside* the semantic-view query rather than applied to its output, because a KPI card showing total revenue filtered to one region has no `REGION` column in its result to filter on.

**Files:**
- Create: `backend/tests/integration/test_filter_spike_it.py`
- Create: `docs/superpowers/specs/2026-08-15-filter-spike-findings.md`

**Interfaces:**
- Consumes: `app.snowflake.connect.connect_dev`, `app.semantic.discovery.describe_semantic_view`, `app.semantic.discovery.quote_ident`
- Produces: the findings file. Task 3 and Task 4 read it to pick the placeholder token (`?` vs `%s`) and the clause position.

**Prerequisite:** `backend/.env` must carry `SEMANTICUI_IT_ACCOUNT`, `SEMANTICUI_IT_USER`, `SEMANTICUI_IT_PASSWORD`, and ideally `SEMANTICUI_IT_DATABASE` / `SEMANTICUI_IT_SCHEMA` / `SEMANTICUI_IT_VIEW` pointing at a real semantic view with at least one text dimension and one metric. Without `SEMANTICUI_IT_ACCOUNT` the module skips — **a skipped spike is not a passed spike.** If it skips, stop and tell the user the credentials are missing.

- [ ] **Step 1: Write the spike**

The four questions are four tests. Each prints what it learned, because the printed output *is* the deliverable.

```python
"""Spike: can SEMANTIC_VIEW() be filtered, and can the values be bound?

Not a regression suite -- this exists to answer four questions against a real
account before the filter feature is designed around the answers. Run with:

    pytest tests/integration/test_filter_spike_it.py -v -s -m integration

The -s matters: the printed output is the deliverable.
"""
import os

import pytest
import snowflake.connector

from app.semantic.discovery import describe_semantic_view, list_semantic_views, quote_ident
from app.snowflake import connect as sf_connect

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("SEMANTICUI_IT_ACCOUNT"),
        reason="SEMANTICUI_IT_* env vars not set",
    ),
]


@pytest.fixture(scope="module")
def conn():
    connection = sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
    )
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def model(conn):
    db = os.environ.get("SEMANTICUI_IT_DATABASE")
    schema = os.environ.get("SEMANTICUI_IT_SCHEMA")
    name = os.environ.get("SEMANTICUI_IT_VIEW")
    if not (db and schema and name):
        views = list_semantic_views(conn)
        assert views, "account has no semantic views visible to this user"
        db, schema, name = views[0]["database"], views[0]["schema"], views[0]["name"]
    detail = describe_semantic_view(conn, db, schema, name)
    text_dims = [
        d for d in detail["dimensions"]
        if (d.get("dataType") or "").upper().startswith(("VARCHAR", "TEXT", "STRING", "CHAR"))
    ]
    assert text_dims, "spike needs at least one text dimension"
    assert detail["metrics"], "spike needs at least one metric"
    return {
        "ref": f"{quote_ident(db)}.{quote_ident(schema)}.{quote_ident(name)}",
        "dim": text_dims[0],
        "metric": detail["metrics"][0],
    }


def _fq(field: dict) -> str:
    return f"{quote_ident(field['table'])}.{quote_ident(field['name'])}"


def _sample_value(conn, model) -> str:
    """One real value of the chosen dimension, to filter on."""
    sql = (
        f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
        f"  DIMENSIONS {_fq(model['dim'])}\n) LIMIT 1"
    )
    cur = conn.cursor()
    try:
        cur.execute(sql)
        row = cur.fetchone()
        assert row is not None and row[0] is not None, "dimension has no non-null values"
        return str(row[0])
    finally:
        cur.close()


def test_q1_where_clause_is_accepted(conn, model):
    """Q1: does SEMANTIC_VIEW(...) take a WHERE clause, and where does it go?"""
    value = _sample_value(conn, model)
    inside = (
        f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
        f"  DIMENSIONS {_fq(model['dim'])}\n"
        f"  METRICS {_fq(model['metric'])}\n"
        f"  WHERE {_fq(model['dim'])} = '{value.replace(chr(39), chr(39) * 2)}'\n) LIMIT 10"
    )
    cur = conn.cursor()
    try:
        try:
            cur.execute(inside)
            rows = cur.fetchall()
            print(f"\n[Q1] WHERE *inside* SEMANTIC_VIEW: ACCEPTED, {len(rows)} row(s)")
            print(f"[Q1] SQL:\n{inside}")
            return
        except snowflake.connector.errors.Error as exc:
            print(f"\n[Q1] WHERE inside SEMANTIC_VIEW REJECTED: {exc.errno} {exc.msg}")
        outside = (
            f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
            f"  DIMENSIONS {_fq(model['dim'])}\n"
            f"  METRICS {_fq(model['metric'])}\n"
            f") WHERE {quote_ident(model['dim']['name'])} = "
            f"'{value.replace(chr(39), chr(39) * 2)}' LIMIT 10"
        )
        cur.execute(outside)
        rows = cur.fetchall()
        print(f"[Q1] WHERE *outside* the call: ACCEPTED, {len(rows)} row(s)")
        print(f"[Q1] SQL:\n{outside}")
        pytest.fail(
            "ASSUMPTION BROKEN: WHERE is only accepted outside SEMANTIC_VIEW(). "
            "Filtering cannot precede aggregation this way -- see the spec's "
            "ranked fallbacks and get sign-off before continuing."
        )
    finally:
        cur.close()


@pytest.mark.parametrize("paramstyle,placeholder", [("qmark", "?"), ("pyformat", "%s")])
def test_q2_bind_parameters_inside_the_filter(model, paramstyle, placeholder):
    """Q2: do bind parameters work inside that clause, and in which paramstyle?

    A fresh connection per paramstyle: the connector decides client- vs
    server-side binding from this value at connect time.
    """
    connection = snowflake.connector.connect(
        account=sf_connect.normalize_account(os.environ["SEMANTICUI_IT_ACCOUNT"]),
        user=os.environ["SEMANTICUI_IT_USER"],
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
        paramstyle=paramstyle,
    )
    try:
        value = _sample_value(connection, model)
        sql = (
            f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
            f"  DIMENSIONS {_fq(model['dim'])}\n"
            f"  METRICS {_fq(model['metric'])}\n"
            f"  WHERE {_fq(model['dim'])} IN ({placeholder})\n) LIMIT 10"
        )
        cur = connection.cursor()
        try:
            cur.execute(sql, (value,))
            rows = cur.fetchall()
            print(f"\n[Q2] paramstyle={paramstyle!r} ({placeholder}): ACCEPTED, {len(rows)} row(s)")
        except snowflake.connector.errors.Error as exc:
            print(f"\n[Q2] paramstyle={paramstyle!r} ({placeholder}): REJECTED {exc.errno} {exc.msg}")
            pytest.fail(f"paramstyle {paramstyle} does not bind inside SEMANTIC_VIEW()")
        finally:
            cur.close()
    finally:
        connection.close()


def test_q3_filter_on_a_dimension_not_in_dimensions(conn, model):
    """Q3: the KPI case -- filter on a dimension the query does not select.

    This is the question that decides the feature's shape. A KPI card selects
    only a metric; if the filtered dimension must also appear in DIMENSIONS,
    every KPI card silently becomes a one-row table.
    """
    value = _sample_value(conn, model)
    sql = (
        f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
        f"  METRICS {_fq(model['metric'])}\n"
        f"  WHERE {_fq(model['dim'])} = ?\n) LIMIT 10"
    )
    cur = conn.cursor()
    try:
        cur.execute(sql, (value,))
        rows = cur.fetchall()
        print(f"\n[Q3] filter on an unselected dimension: ACCEPTED, {len(rows)} row(s)")
        print(f"[Q3] rows: {rows[:3]}")
    except snowflake.connector.errors.Error as exc:
        print(f"\n[Q3] filter on an unselected dimension: REJECTED {exc.errno} {exc.msg}")
        pytest.fail(
            "ASSUMPTION BROKEN: a filtered dimension must also be selected. "
            "KPI cards cannot be filtered without becoming grouped results -- "
            "stop and get sign-off on the spec's fallback."
        )
    finally:
        cur.close()


def test_q4_clause_order_relative_to_order_by_and_limit(conn, model):
    """Q4: does WHERE coexist with ORDER BY and LIMIT, and in what order?"""
    value = _sample_value(conn, model)
    sql = (
        f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
        f"  DIMENSIONS {_fq(model['dim'])}\n"
        f"  METRICS {_fq(model['metric'])}\n"
        f"  WHERE {_fq(model['dim'])} <> ?\n"
        f") ORDER BY {quote_ident(model['metric']['name'])} DESC LIMIT 5"
    )
    cur = conn.cursor()
    try:
        cur.execute(sql, (value,))
        rows = cur.fetchall()
        print(f"\n[Q4] WHERE + ORDER BY + LIMIT together: ACCEPTED, {len(rows)} row(s)")
        print(f"[Q4] SQL:\n{sql}")
    finally:
        cur.close()
```

- [ ] **Step 2: Run the spike**

```bash
cd backend && python -m pytest tests/integration/test_filter_spike_it.py -v -s -m integration
```

Expected: four tests pass, printing the accepted syntax. **If the module skips**, the credentials are missing — stop and report. **If Q1 or Q3 fails**, the assumption is broken — stop, write the findings file with the exact error, and report to the user. Do not continue.

- [ ] **Step 3: Write the findings file**

Create `docs/superpowers/specs/2026-08-15-filter-spike-findings.md` recording, with the real output pasted in: whether `WHERE` goes inside or outside the call; the exact clause order; which paramstyle(s) bind (`qmark`/`?` preferred — it is genuine server-side binding, where `pyformat`/`%s` is client-side escaping by the connector); whether Q3 passed; and one line stating which placeholder token Tasks 3 and 4 must use.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/integration/test_filter_spike_it.py docs/superpowers/specs/2026-08-15-filter-spike-findings.md
git commit -m "spike: verify SEMANTIC_VIEW accepts WHERE with bound parameters"
```

---

## Task 2: The filter model and the v1→v2 migration

Filters and hierarchies enter the definition document. The document currently demands `schemaVersion == 1` exactly and forbids extra keys, so without a migration every stored report becomes unreadable the moment this ships.

**Files:**
- Create: `backend/app/reports/filters.py`
- Create: `backend/app/reports/migrate.py`
- Modify: `backend/app/reports/schema.py`
- Test: `backend/tests/test_report_filters.py`, `backend/tests/test_report_migrate.py`, `backend/tests/test_report_schema.py`

**Interfaces:**
- Consumes: `app.reports.schema.MAX_REF_LENGTH` (511), `app.errors.ApiError`
- Produces:
  - `MAX_FILTER_VALUES = 500`, `MAX_VALUE_LENGTH = 255`, `MAX_FILTERS_PER_SCOPE = 50`
  - `class InFilter` (`op: "is" | "isNot"`, `values: list[str]`)
  - `class BetweenFilter` (`op: "between"`, `from_: str | float` aliased `from`, `to: str | float`)
  - `class RelativeDateFilter` (`op: "relativeDate"`, `unit`, `count`, `preset`)
  - `Filter` — the discriminated union on `op`
  - `migrate_definition(raw: dict) -> dict`
  - `SCHEMA_VERSION = 2`; `ReportDefinition.filters`, `.hierarchies`; `Visual.filters`; `class Hierarchy`

- [ ] **Step 1: Write the failing filter-model test**

```python
# backend/tests/test_report_filters.py
import pytest
from pydantic import TypeAdapter, ValidationError

from app.reports.filters import (
    MAX_FILTER_VALUES,
    MAX_VALUE_LENGTH,
    BetweenFilter,
    Filter,
    InFilter,
    RelativeDateFilter,
)

ADAPTER = TypeAdapter(Filter)


def test_is_filter_parses():
    f = ADAPTER.validate_python(
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST", "WEST"]}
    )
    assert isinstance(f, InFilter)
    assert f.values == ["EAST", "WEST"]


def test_is_not_filter_parses():
    f = ADAPTER.validate_python(
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "isNot", "values": ["EAST"]}
    )
    assert isinstance(f, InFilter) and f.op == "isNot"


def test_unknown_operator_is_rejected():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "matches", "values": ["E%"]}
        )


def test_empty_value_list_is_rejected():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": []}
        )


def test_too_many_values_is_rejected():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python({
            "id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
            "values": [str(i) for i in range(MAX_FILTER_VALUES + 1)],
        })


def test_an_overlong_value_is_rejected():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python({
            "id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
            "values": ["x" * (MAX_VALUE_LENGTH + 1)],
        })


def test_between_parses_and_keeps_the_from_alias():
    f = ADAPTER.validate_python(
        {"id": "f1", "field": "ORDERS.TOTAL", "op": "between", "from": 10, "to": 20}
    )
    assert isinstance(f, BetweenFilter)
    assert (f.from_, f.to) == (10, 20)
    assert f.model_dump(by_alias=True)["from"] == 10


def test_between_rejects_reversed_endpoints():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "ORDERS.TOTAL", "op": "between", "from": 20, "to": 10}
        )


def test_between_rejects_mixed_endpoint_kinds():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "ORDERS.TOTAL", "op": "between", "from": 10, "to": "2026-01-01"}
        )


def test_relative_date_accepts_unit_and_count():
    f = ADAPTER.validate_python({
        "id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
        "unit": "day", "count": 30,
    })
    assert isinstance(f, RelativeDateFilter) and f.count == 30


def test_relative_date_accepts_a_preset():
    f = ADAPTER.validate_python({
        "id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
        "preset": "monthToDate",
    })
    assert f.preset == "monthToDate"


def test_relative_date_rejects_both_forms_at_once():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python({
            "id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
            "unit": "day", "count": 30, "preset": "monthToDate",
        })


def test_relative_date_rejects_neither_form():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python(
            {"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate"}
        )


def test_extra_keys_are_forbidden():
    with pytest.raises(ValidationError):
        ADAPTER.validate_python({
            "id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
            "values": ["EAST"], "sql": "1=1",
        })
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && python -m pytest tests/test_report_filters.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'app.reports.filters'`

- [ ] **Step 3: Write the filter model**

```python
# backend/app/reports/filters.py
"""Filters as they appear in the report definition document.

This module is deliberately SQL-free. It decides what a filter may say;
`app/semantic/predicates.py` decides what SQL that becomes. Keeping the two
apart is what makes "values are bound parameters, never SQL text" checkable
in one place instead of everywhere a filter is read.
"""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

# A filter with 500 values already produces a 500-placeholder IN list. Beyond
# that the cost is the user's to justify, not ours to absorb silently.
MAX_FILTER_VALUES = 500
# Snowflake identifiers top out at 255 characters and so, in practice, do the
# dimension values worth filtering on by equality.
MAX_VALUE_LENGTH = 255
MAX_FILTERS_PER_SCOPE = 50
# 511 = 255 + "." + 255, the longest legitimate TABLE.FIELD reference.
MAX_REF_LENGTH = 511

FilterValue = Annotated[str, Field(max_length=MAX_VALUE_LENGTH)]


class _StrictFilter(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1, max_length=64)
    field: str = Field(min_length=1, max_length=MAX_REF_LENGTH)


class InFilter(_StrictFilter):
    op: Literal["is", "isNot"]
    values: list[FilterValue] = Field(min_length=1, max_length=MAX_FILTER_VALUES)


class BetweenFilter(_StrictFilter):
    op: Literal["between"]
    # `from` is a Python keyword, so the attribute is `from_` and the wire
    # name stays `from` via the alias.
    from_: Union[str, float] = Field(alias="from")
    to: Union[str, float]

    @model_validator(mode="after")
    def _ordered_and_same_kind(self) -> "BetweenFilter":
        lo, hi = self.from_, self.to
        if isinstance(lo, str) != isinstance(hi, str):
            raise ValueError("between endpoints must both be numbers or both be dates")
        if lo > hi:  # type: ignore[operator]
            raise ValueError("between requires from <= to")
        return self


class RelativeDateFilter(_StrictFilter):
    op: Literal["relativeDate"]
    unit: Literal["day", "month", "year"] | None = None
    # 3650 days is ten years; past that a relative window is really an
    # absolute one and `between` is the honest operator.
    count: int | None = Field(default=None, ge=1, le=3650)
    preset: Literal["monthToDate", "yearToDate"] | None = None

    @model_validator(mode="after")
    def _exactly_one_form(self) -> "RelativeDateFilter":
        has_window = self.unit is not None and self.count is not None
        has_preset = self.preset is not None
        if has_window and has_preset:
            raise ValueError("relativeDate takes either unit+count or preset, not both")
        if not has_window and not has_preset:
            raise ValueError("relativeDate needs either unit+count or preset")
        if (self.unit is None) != (self.count is None):
            raise ValueError("relativeDate needs unit and count together")
        return self


# Discriminated on `op`, so an unknown operator fails at the union rather than
# falling through to whichever member happens to accept the payload.
Filter = Annotated[
    Union[InFilter, BetweenFilter, RelativeDateFilter],
    Field(discriminator="op"),
]

FilterList = Annotated[list[Filter], Field(max_length=MAX_FILTERS_PER_SCOPE)]
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd backend && python -m pytest tests/test_report_filters.py -v
```
Expected: PASS (14 tests)

- [ ] **Step 5: Write the failing migration test**

```python
# backend/tests/test_report_migrate.py
from app.reports.migrate import migrate_definition
from app.reports.schema import SCHEMA_VERSION

V1 = {
    "schemaVersion": 1,
    "name": "Sales overview",
    "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
    "canvas": {"columns": 12, "rowHeight": 40},
    "visuals": [{
        "id": "v1", "type": "bar", "title": "",
        "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
        "wells": {"axis": ["CUSTOMERS.REGION"], "legend": [], "values": ["ORDERS.TOTAL_REVENUE"]},
        "options": {},
    }],
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
    v2 = {**V1, "schemaVersion": 2, "filters": [
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
    ], "hierarchies": []}
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
```

- [ ] **Step 6: Run it to verify it fails**

```bash
cd backend && python -m pytest tests/test_report_migrate.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'app.reports.migrate'`

- [ ] **Step 7: Write the migration**

```python
# backend/app/reports/migrate.py
"""Upgrade older definition documents to the current schema version.

Runs BEFORE pydantic validation, because the document model demands the
current `schemaVersion` exactly and forbids unknown keys -- a v1 document
would be rejected before anything got the chance to upgrade it.

Deliberately tolerant: anything malformed is passed through untouched so the
validator produces the error, rather than this module raising a second,
less specific one.
"""


def migrate_definition(raw: object) -> object:
    """Return `raw` upgraded to the current schema version. Never mutates it."""
    if not isinstance(raw, dict):
        return raw
    if raw.get("schemaVersion") != 1:
        return raw

    upgraded = {
        **raw,
        "schemaVersion": 2,
        # `setdefault` semantics, not overwrite: a hand-written v1 document
        # that already carries these keys keeps what it says.
        "filters": raw.get("filters", []),
        "hierarchies": raw.get("hierarchies", []),
    }

    visuals = raw.get("visuals")
    if isinstance(visuals, list):
        upgraded["visuals"] = [
            {**v, "filters": v.get("filters", [])} if isinstance(v, dict) else v
            for v in visuals
        ]
    return upgraded
```

- [ ] **Step 8: Run it to verify it passes**

```bash
cd backend && python -m pytest tests/test_report_migrate.py -v
```
Expected: PASS (8 tests)

- [ ] **Step 9: Write the failing document-schema test**

Append to `backend/tests/test_report_schema.py`:

```python
from app.reports.schema import parse_definition


def _v2(**overrides) -> dict:
    base = {
        "schemaVersion": 2,
        "name": "R",
        "view": {"database": "D", "schema": "S", "name": "V"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": [],
        "filters": [],
        "hierarchies": [],
    }
    return {**base, **overrides}


def _bar(**overrides) -> dict:
    base = {
        "id": "v1", "type": "bar", "title": "",
        "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
        "wells": {"axis": ["CUSTOMERS.REGION"], "legend": [], "values": ["ORDERS.TOTAL"]},
        "options": {}, "filters": [],
    }
    return {**base, **overrides}


def test_a_v1_document_still_parses_through_the_migration():
    v1 = {
        "schemaVersion": 1, "name": "R",
        "view": {"database": "D", "schema": "S", "name": "V"},
        "canvas": {"columns": 12, "rowHeight": 40}, "visuals": [],
    }
    definition = parse_definition(v1)
    assert definition.schemaVersion == 2
    assert definition.filters == []


def test_report_scope_filters_parse():
    definition = parse_definition(_v2(filters=[
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
    ]))
    assert definition.filters[0].field == "CUSTOMERS.REGION"


def test_visual_scope_filters_parse():
    definition = parse_definition(_v2(visuals=[_bar(filters=[
        {"id": "f2", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
         "unit": "day", "count": 30}
    ])]))
    assert definition.visuals[0].filters[0].op == "relativeDate"


def test_an_unknown_operator_is_report_invalid():
    with pytest.raises(ApiError) as exc:
        parse_definition(_v2(filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "regex", "values": [".*"]}
        ]))
    assert exc.value.code == "REPORT_INVALID"


def test_duplicate_filter_ids_are_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(_v2(filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]},
            {"id": "f1", "field": "CUSTOMERS.COUNTRY", "op": "is", "values": ["US"]},
        ]))
    assert "f1" in exc.value.message


def test_a_hierarchy_parses():
    definition = parse_definition(_v2(hierarchies=[
        {"id": "h1", "name": "Geography",
         "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"]}
    ]))
    assert definition.hierarchies[0].levels[2] == "CUSTOMERS.CITY"


def test_a_one_level_hierarchy_is_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(_v2(hierarchies=[
            {"id": "h1", "name": "Geography", "levels": ["CUSTOMERS.COUNTRY"]}
        ]))
    assert "two levels" in exc.value.message


def test_duplicate_levels_within_one_hierarchy_are_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(_v2(hierarchies=[
            {"id": "h1", "name": "Geo",
             "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.COUNTRY"]}
        ]))
    assert "more than once" in exc.value.message


def test_a_well_may_reference_a_declared_hierarchy():
    definition = parse_definition(_v2(
        hierarchies=[{"id": "h1", "name": "Geo",
                      "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE"]}],
        visuals=[_bar(wells={"axis": ["hierarchy:h1"], "legend": [],
                             "values": ["ORDERS.TOTAL"]})],
    ))
    assert definition.visuals[0].wells["axis"] == ["hierarchy:h1"]


def test_a_well_referencing_an_undeclared_hierarchy_is_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(_v2(visuals=[
            _bar(wells={"axis": ["hierarchy:nope"], "legend": [],
                        "values": ["ORDERS.TOTAL"]})
        ]))
    assert "hierarchy:nope" in exc.value.message


def test_a_hierarchy_reference_in_a_metric_well_is_rejected():
    with pytest.raises(ApiError) as exc:
        parse_definition(_v2(
            hierarchies=[{"id": "h1", "name": "Geo",
                          "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE"]}],
            visuals=[_bar(wells={"axis": ["CUSTOMERS.REGION"], "legend": [],
                                 "values": ["hierarchy:h1"]})],
        ))
    assert "Values" in exc.value.message
```

- [ ] **Step 10: Run it to verify it fails**

```bash
cd backend && python -m pytest tests/test_report_schema.py -v
```
Expected: FAIL — the v1 test fails on `Unsupported schemaVersion 1`, the rest on unknown keys `filters`/`hierarchies`.

- [ ] **Step 11: Extend the document schema**

In `backend/app/reports/schema.py`, change `SCHEMA_VERSION` to `2`, add the imports, add the `Hierarchy` model, add the new fields, call the migration, and validate hierarchy references.

Replace the imports and constants block:

```python
from app.errors import ApiError, safe_error_details
from app.reports.catalog import CATALOG, validate_wells
from app.reports.filters import FilterList
from app.reports.migrate import migrate_definition

SCHEMA_VERSION = 2
MAX_VISUALS = 50
MAX_DEFINITION_BYTES = 65536
MAX_HIERARCHIES = 20
MAX_HIERARCHY_LEVELS = 10
```

and add to `backend/app/reports/catalog.py`, next to the `CATALOG` dict (schema.py already imports from this module, and Task 6 needs it here too — declaring it once avoids the two copies drifting):

```python
# A well entry of the form "hierarchy:<id>" stands in for a whole drill path
# rather than a single field.
HIERARCHY_PREFIX = "hierarchy:"
```

Add after `class VisualLayout`:

```python
class Hierarchy(_Strict):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    levels: list[WellRef] = Field(min_length=1, max_length=MAX_HIERARCHY_LEVELS)
```

Add `filters: FilterList = Field(default_factory=list)` to `Visual`, and to `ReportDefinition` add:

```python
    filters: FilterList = Field(default_factory=list)
    hierarchies: list[Hierarchy] = Field(
        default_factory=list, max_length=MAX_HIERARCHIES
    )
```

In `parse_definition`, run the migration first — before the byte check, so the size bound measures what is actually stored:

```python
def parse_definition(raw: dict) -> ReportDefinition:
    """Validate an untrusted definition document. Raises ApiError on any problem."""
    if not isinstance(raw, dict):
        raise _invalid("A report definition must be a JSON object")

    # Upgrade first: the model below demands the current schemaVersion exactly
    # and forbids unknown keys, so a v1 document has to become a v2 document
    # before it is ever handed to pydantic.
    raw = migrate_definition(raw)

    # Every write path (create, update, import) funnels through here, so this
    # is the one place that bounds what a definition can weigh before any
    # more expensive validation (or a database write) happens.
    if len(json.dumps(raw)) > MAX_DEFINITION_BYTES:
        raise _invalid(f"The definition exceeds the {MAX_DEFINITION_BYTES} byte limit")
```

Then, after the existing visual loop, add filter-id and hierarchy validation:

```python
    _check_unique_filter_ids(definition)
    _check_hierarchies(definition)

    return definition


def _check_unique_filter_ids(definition: ReportDefinition) -> None:
    """Filter ids must be unique within their scope, so the UI can address one."""
    for scope, filters in [("report", definition.filters)] + [
        (f"visual {v.id!r}", v.filters) for v in definition.visuals
    ]:
        seen: set[str] = set()
        for f in filters:
            if f.id in seen:
                raise _invalid(f"Duplicate filter id {f.id!r} in {scope} filters")
            seen.add(f.id)


def _check_hierarchies(definition: ReportDefinition) -> None:
    by_id: dict[str, Hierarchy] = {}
    for hierarchy in definition.hierarchies:
        if hierarchy.id in by_id:
            raise _invalid(f"Duplicate hierarchy id {hierarchy.id!r}")
        if len(hierarchy.levels) < 2:
            raise _invalid(
                f"Hierarchy {hierarchy.name!r} needs at least two levels; a "
                "one-level hierarchy is just a field"
            )
        seen_levels: set[str] = set()
        for level in hierarchy.levels:
            if level.upper() in seen_levels:
                raise _invalid(
                    f"Hierarchy {hierarchy.name!r} lists {level} more than once"
                )
            seen_levels.add(level.upper())
        by_id[hierarchy.id] = hierarchy

    for visual in definition.visuals:
        spec = CATALOG[visual.type]
        for well_key, refs in visual.wells.items():
            for ref in refs:
                if not ref.startswith(HIERARCHY_PREFIX):
                    continue
                well = spec.well(well_key)
                if well is not None and well.kind != "dimension":
                    raise _invalid(
                        f"Visual {visual.id!r}: {well.label} takes metrics, so it "
                        f"cannot hold the hierarchy reference {ref!r}"
                    )
                if ref[len(HIERARCHY_PREFIX):] not in by_id:
                    raise _invalid(
                        f"Visual {visual.id!r} references {ref!r}, but this report "
                        "declares no such hierarchy"
                    )
```

- [ ] **Step 12: Run the whole report suite**

```bash
cd backend && python -m pytest tests/test_report_schema.py tests/test_report_filters.py tests/test_report_migrate.py tests/test_report_routes.py tests/test_report_import.py -v
```
Expected: PASS. Existing tests that build v1 documents still pass — they migrate. If any existing test asserts `schemaVersion == 1` on output, update it to `SCHEMA_VERSION`; do not weaken the assertion to "any version".

- [ ] **Step 13: Commit**

```bash
git add backend/app/reports/filters.py backend/app/reports/migrate.py backend/app/reports/schema.py backend/tests/test_report_filters.py backend/tests/test_report_migrate.py backend/tests/test_report_schema.py
git commit -m "feat: filter and hierarchy models in the definition document, with a v1 migration"
```

---

## Task 3: The predicate builder — filters become SQL fragments plus bound values

This is the security-critical file. It is the only place a filter turns into SQL, which is what makes "values are bound parameters, never SQL text" a property you can check by reading one module.

**Files:**
- Create: `backend/app/semantic/predicates.py`
- Test: `backend/tests/test_predicates.py`

**Interfaces:**
- Consumes: `app.reports.filters.{Filter, InFilter, BetweenFilter, RelativeDateFilter}`, `app.semantic.discovery.quote_ident`, `app.errors.ApiError`
- Produces:
  - `PLACEHOLDER: str` — `"?"` (change only if Task 1's findings say otherwise)
  - `build_filter_predicates(detail: dict, filters: list[Filter], *, today: date | None = None) -> tuple[list[str], list[object]]`
  - `resolve_relative_date(f: RelativeDateFilter, today: date) -> tuple[date, date]`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_predicates.py
from datetime import date

import pytest
from pydantic import TypeAdapter

from app.errors import ApiError
from app.reports.filters import Filter
from app.semantic.predicates import (
    PLACEHOLDER,
    build_filter_predicates,
    resolve_relative_date,
)

ADAPTER = TypeAdapter(list[Filter])

DETAIL = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMERS"}],
    "relationships": [],
    "dimensions": [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "VARCHAR(16777216)"},
    ],
    "metrics": [{"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER(38,2)"}],
    "facts": [{"table": "ORDERS", "name": "ORDER_AMOUNT", "dataType": "NUMBER(38,2)"}],
}


def build(payload: list[dict], **kwargs):
    return build_filter_predicates(DETAIL, ADAPTER.validate_python(payload), **kwargs)


def test_no_filters_produces_nothing():
    assert build([]) == ([], [])


def test_is_with_one_value_emits_equals():
    sql, params = build([
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
    ])
    assert sql == [f'"CUSTOMERS"."REGION" = {PLACEHOLDER}']
    assert params == ["EAST"]


def test_is_with_many_values_emits_in():
    sql, params = build([
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
         "values": ["EAST", "WEST", "NORTH"]}
    ])
    assert sql == [
        f'"CUSTOMERS"."REGION" IN ({PLACEHOLDER}, {PLACEHOLDER}, {PLACEHOLDER})'
    ]
    assert params == ["EAST", "WEST", "NORTH"]


def test_is_not_negates():
    sql, params = build([
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "isNot", "values": ["EAST", "WEST"]}
    ])
    assert sql == [f'"CUSTOMERS"."REGION" NOT IN ({PLACEHOLDER}, {PLACEHOLDER})']
    assert params == ["EAST", "WEST"]


def test_between_emits_two_placeholders():
    sql, params = build([
        {"id": "f1", "field": "ORDERS.ORDER_AMOUNT", "op": "between", "from": 10, "to": 20}
    ])
    assert sql == [f'"ORDERS"."ORDER_AMOUNT" BETWEEN {PLACEHOLDER} AND {PLACEHOLDER}']
    assert params == [10, 20]


def test_parameters_are_ordered_across_several_filters():
    """The cursor binds positionally, so a wrong order is a wrong answer rather
    than an error -- worth pinning explicitly."""
    sql, params = build([
        {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST", "WEST"]},
        {"id": "f2", "field": "ORDERS.ORDER_AMOUNT", "op": "between", "from": 1, "to": 9},
    ])
    assert len(sql) == 2
    assert params == ["EAST", "WEST", 1, 9]


def test_relative_date_resolves_server_side_to_two_bound_dates():
    sql, params = build(
        [{"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
          "unit": "day", "count": 30}],
        today=date(2026, 8, 15),
    )
    assert sql == [f'"ORDERS"."ORDER_DATE" BETWEEN {PLACEHOLDER} AND {PLACEHOLDER}']
    assert params == [date(2026, 7, 17), date(2026, 8, 15)]


def test_a_filter_may_reference_a_fact():
    sql, _ = build([
        {"id": "f1", "field": "ORDERS.ORDER_AMOUNT", "op": "between", "from": 1, "to": 2}
    ])
    assert sql[0].startswith('"ORDERS"."ORDER_AMOUNT"')


def test_filtering_on_a_metric_is_rejected():
    """An aggregate needs HAVING, not WHERE. Rejecting beats silently building
    a query that means something else."""
    with pytest.raises(ApiError) as exc:
        build([{"id": "f1", "field": "ORDERS.TOTAL_REVENUE", "op": "between",
                "from": 1, "to": 2}])
    assert exc.value.code == "QUERY_ERROR"
    assert "aggregate" in exc.value.message.lower()


def test_an_unknown_field_is_rejected():
    with pytest.raises(ApiError) as exc:
        build([{"id": "f1", "field": "CUSTOMERS.NOPE", "op": "is", "values": ["X"]}])
    assert "CUSTOMERS.NOPE" in exc.value.message


def test_an_unqualified_field_is_rejected():
    with pytest.raises(ApiError):
        build([{"id": "f1", "field": "REGION", "op": "is", "values": ["X"]}])


def test_the_field_name_comes_from_the_catalog_not_the_request():
    """Case is normalised to what DESCRIBE reported, so the emitted identifier
    can never be attacker-shaped even when the reference matches."""
    sql, _ = build([{"id": "f1", "field": "customers.region", "op": "is", "values": ["X"]}])
    assert sql == [f'"CUSTOMERS"."REGION" = {PLACEHOLDER}']


class TestInjectionRoundTrip:
    """The central security property: a value containing SQL metacharacters
    must survive as data and appear nowhere in the generated SQL text."""

    HOSTILE = [
        "' OR 1=1 --",
        "'; DROP TABLE ORDERS; --",
        '" OR ""="',
        "\\'; SELECT 1; --",
        "EAST') OR ('1'='1",
    ]

    def test_hostile_values_never_reach_the_sql_string(self):
        sql, params = build([
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": self.HOSTILE}
        ])
        joined = " ".join(sql)
        for value in self.HOSTILE:
            assert value not in joined, f"{value!r} leaked into SQL text"
        assert params == self.HOSTILE
        # Nothing but placeholders and the quoted identifier survive.
        assert joined.count(PLACEHOLDER) == len(self.HOSTILE)
        assert "'" not in joined
        assert "--" not in joined
        assert ";" not in joined

    def test_a_hostile_between_endpoint_is_bound_too(self):
        sql, params = build([{
            "id": "f1", "field": "ORDERS.ORDER_DATE", "op": "between",
            "from": "2026-01-01' OR '1'='1", "to": "2026-12-31",
        }])
        assert "OR" not in sql[0]
        assert params[0] == "2026-01-01' OR '1'='1"


class TestRelativeDateResolution:
    """Resolution runs against a passed-in clock, so these assert exact dates
    rather than 'about a month ago'."""

    TODAY = date(2026, 8, 15)

    def resolve(self, **payload):
        f = TypeAdapter(Filter).validate_python(
            {"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate", **payload}
        )
        return resolve_relative_date(f, self.TODAY)

    def test_last_1_day_is_today_only(self):
        assert self.resolve(unit="day", count=1) == (date(2026, 8, 15), date(2026, 8, 15))

    def test_last_7_days_is_a_seven_day_window_ending_today(self):
        assert self.resolve(unit="day", count=7) == (date(2026, 8, 9), date(2026, 8, 15))

    def test_last_3_months_starts_at_the_first_of_the_third_month_back(self):
        assert self.resolve(unit="month", count=3) == (date(2026, 6, 1), date(2026, 8, 15))

    def test_a_month_window_crossing_a_year_boundary(self):
        f = TypeAdapter(Filter).validate_python(
            {"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
             "unit": "month", "count": 3}
        )
        assert resolve_relative_date(f, date(2026, 1, 20)) == (
            date(2025, 11, 1), date(2026, 1, 20)
        )

    def test_last_2_years_starts_at_january_of_the_prior_year(self):
        assert self.resolve(unit="year", count=2) == (date(2025, 1, 1), date(2026, 8, 15))

    def test_month_to_date(self):
        assert self.resolve(preset="monthToDate") == (date(2026, 8, 1), date(2026, 8, 15))

    def test_year_to_date(self):
        assert self.resolve(preset="yearToDate") == (date(2026, 1, 1), date(2026, 8, 15))
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_predicates.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.semantic.predicates'`

- [ ] **Step 3: Write the predicate builder**

```python
# backend/app/semantic/predicates.py
"""Turn filters into SQL predicates and an ordered list of values to bind.

THE RULE THIS FILE EXISTS TO ENFORCE: a filter VALUE never becomes SQL text.
Every value leaves here in the `params` list; the only things that reach the
statement are a placeholder and an identifier taken from the DESCRIBE catalog.
If you are about to write an f-string that interpolates a value, stop -- that
is the bug this module was written to make impossible.
"""

from datetime import date, timedelta
from typing import Any

from app.errors import ApiError
from app.reports.filters import BetweenFilter, Filter, InFilter, RelativeDateFilter
from app.semantic.discovery import quote_ident

# Server-side binding with the `qmark` paramstyle, as established by the
# Task 1 spike. `pyformat`/"%s" would also work but binds client-side (the
# connector escapes and interpolates), which is strictly weaker.
PLACEHOLDER = "?"


def _filterable(detail: dict) -> dict[tuple[str, str], tuple[str, str]]:
    """Fields a WHERE clause may name, keyed case-insensitively.

    Dimensions and facts are raw columns. Metrics are aggregates: filtering
    one is a HAVING, a different shape, so they are deliberately absent here
    and `_resolve` reports them specifically rather than as "unknown field".
    """
    catalog: dict[tuple[str, str], tuple[str, str]] = {}
    for kind in ("dimensions", "facts"):
        for f in detail.get(kind, []):
            table, name = f.get("table") or "", f["name"]
            catalog[(table.upper(), name.upper())] = (table, name)
    return catalog


def _metric_refs(detail: dict) -> set[tuple[str, str]]:
    return {
        ((m.get("table") or "").upper(), m["name"].upper())
        for m in detail.get("metrics", [])
    }


def _resolve(detail: dict, ref: str) -> tuple[str, str]:
    if "." not in ref:
        raise ApiError("QUERY_ERROR", 400, f"Filter field must be TABLE.NAME: {ref}")
    table, name = ref.split(".", 1)
    key = (table.upper(), name.upper())
    hit = _filterable(detail).get(key)
    if hit is not None:
        return hit
    if key in _metric_refs(detail):
        raise ApiError(
            "QUERY_ERROR",
            400,
            f"{ref} is a metric, an aggregate value, so it cannot be filtered "
            "here. Filter on a dimension instead.",
        )
    raise ApiError("QUERY_ERROR", 400, f"Unknown filter field: {ref}")


def _add_months(anchor: date, delta: int) -> date:
    """Shift by whole months, clamped to the 1st. Callers only ever want the
    start of a month, so day-overflow (Jan 31 -> Feb 31) cannot arise."""
    total = anchor.year * 12 + (anchor.month - 1) + delta
    return date(total // 12, total % 12 + 1, 1)


def resolve_relative_date(f: RelativeDateFilter, today: date) -> tuple[date, date]:
    """Resolve a relative window to two concrete dates, inclusive at both ends.

    A window of `count` units *ending today*: "last 7 days" covers seven days,
    the seventh of which is today -- not eight days, and not seven days ending
    yesterday.
    """
    if f.preset == "monthToDate":
        return today.replace(day=1), today
    if f.preset == "yearToDate":
        return today.replace(month=1, day=1), today

    count = f.count or 1
    if f.unit == "day":
        return today - timedelta(days=count - 1), today
    if f.unit == "month":
        return _add_months(today, -(count - 1)), today
    return date(today.year - (count - 1), 1, 1), today


def build_filter_predicates(
    detail: dict, filters: list[Filter], *, today: date | None = None
) -> tuple[list[str], list[Any]]:
    """Return (predicate fragments, values to bind), positionally aligned.

    The caller joins the fragments with AND and hands `params` straight to the
    cursor. Order matters: binding is positional.
    """
    if not filters:
        return [], []

    clock = today or date.today()
    fragments: list[str] = []
    params: list[Any] = []

    for f in filters:
        table, name = _resolve(detail, f.field)
        column = f"{quote_ident(table)}.{quote_ident(name)}"

        if isinstance(f, InFilter):
            negated = f.op == "isNot"
            if len(f.values) == 1:
                fragments.append(f"{column} {'<>' if negated else '='} {PLACEHOLDER}")
            else:
                holders = ", ".join(PLACEHOLDER for _ in f.values)
                fragments.append(f"{column} {'NOT IN' if negated else 'IN'} ({holders})")
            params.extend(f.values)
        elif isinstance(f, BetweenFilter):
            fragments.append(f"{column} BETWEEN {PLACEHOLDER} AND {PLACEHOLDER}")
            params.extend([f.from_, f.to])
        elif isinstance(f, RelativeDateFilter):
            start, end = resolve_relative_date(f, clock)
            fragments.append(f"{column} BETWEEN {PLACEHOLDER} AND {PLACEHOLDER}")
            params.extend([start, end])
        else:  # pragma: no cover -- the discriminated union forecloses this
            raise ApiError("QUERY_ERROR", 400, f"Unsupported filter operator on {f.field}")

    return fragments, params
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && python -m pytest tests/test_predicates.py -v`
Expected: PASS (~26 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/semantic/predicates.py backend/tests/test_predicates.py
git commit -m "feat: build filter predicates with bound parameters, never SQL text"
```

---

## Task 4: Thread filters and params through the query path

`build_semantic_sql` currently returns `(sql, effective_limit)` and `run_query` takes no params. Both change, and so does the fake cursor the tests bind against.

**Files:**
- Modify: `backend/app/semantic/query.py`, `backend/app/snowflake/gateway.py`, `backend/app/snowflake/connect.py`, `backend/app/semantic/routes.py:53-56`, `backend/tests/fakes.py:19-23`
- Test: `backend/tests/test_semantic_query.py`, `backend/tests/test_gateway.py`, `backend/tests/test_semantic_routes.py`

**Interfaces:**
- Consumes: `app.semantic.predicates.build_filter_predicates`, `app.reports.filters.FilterList`
- Produces:
  - `build_semantic_sql(detail, req, *, max_rows, today=None) -> tuple[str, list[Any], int]` — **now a 3-tuple**, `(sql, params, effective_limit)`
  - `run_query(conn, sql, *, max_rows, params=None) -> QueryResult`
  - `SemanticQueryRequest.filters: FilterList`
  - `FakeCursor.execute(sql, params=None)` recording `FakeCursor.bound: list`

- [ ] **Step 1: Update the fake cursor first**

Every other test in this task depends on it. In `backend/tests/fakes.py`, replace the `executed` field and `execute` method:

```python
    executed: list[str] = field(default_factory=list)
    #: One entry per execute() call: the params it was given, or None.
    bound: list[Any] = field(default_factory=list)

    def execute(self, sql: str, params: Any = None) -> "FakeCursor":
        self.executed.append(sql)
        self.bound.append(params)
        if self.error is not None:
            raise self.error
        return self
```

Apply the same two-argument signature to `ScriptedCursor.execute` in `backend/tests/test_semantic_routes.py:17`, adding `self.bound: list = []` to its `__init__` and `self.bound.append(params)` alongside `self.executed.append(sql)`.

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/test_semantic_query.py`. It already defines a describe-shaped `DETAIL`; if the existing fixture lacks `CUSTOMERS.REGION` or `ORDERS.ORDER_DATE`, add them rather than defining a second fixture.

```python
from datetime import date


def req(**payload) -> SemanticQueryRequest:
    base = {"database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES"}
    return SemanticQueryRequest.model_validate({**base, **payload})


def test_build_returns_a_three_tuple_with_empty_params_when_unfiltered():
    sql, params, limit = build_semantic_sql(
        DETAIL, req(dimensions=["CUSTOMERS.REGION"], metrics=["ORDERS.TOTAL_REVENUE"]),
        max_rows=100,
    )
    assert params == []
    assert limit == 100
    assert "WHERE" not in sql


def test_a_filter_adds_a_where_clause_inside_the_semantic_view_call():
    sql, params, _ = build_semantic_sql(
        DETAIL,
        req(
            dimensions=["CUSTOMERS.REGION"], metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
                      "values": ["EAST"]}],
        ),
        max_rows=100,
    )
    assert sql.index("WHERE") < sql.index(")"), "WHERE must sit INSIDE SEMANTIC_VIEW(...)"
    assert params == ["EAST"]


def test_several_filters_are_anded():
    sql, params, _ = build_semantic_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]},
                {"id": "f2", "field": "ORDERS.ORDER_DATE", "op": "between",
                 "from": "2026-01-01", "to": "2026-06-30"},
            ],
        ),
        max_rows=100,
    )
    assert " AND " in sql
    assert params == ["EAST", "2026-01-01", "2026-06-30"]


def test_a_kpi_shaped_query_can_filter_on_an_unselected_dimension():
    """The case the spike existed to prove: metrics only, filtered by a
    dimension that is not among DIMENSIONS."""
    sql, params, _ = build_semantic_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
                      "values": ["EAST"]}],
        ),
        max_rows=100,
    )
    assert "DIMENSIONS" not in sql
    assert '"CUSTOMERS"."REGION"' in sql
    assert params == ["EAST"]


def test_where_precedes_order_by_and_limit():
    sql, _, _ = build_semantic_sql(
        DETAIL,
        req(
            dimensions=["CUSTOMERS.REGION"], metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
                      "values": ["EAST"]}],
            orderBy=[{"field": "TOTAL_REVENUE", "direction": "desc"}],
        ),
        max_rows=100,
    )
    assert sql.index("WHERE") < sql.index("ORDER BY") < sql.index("LIMIT")


def test_relative_dates_resolve_against_the_injected_clock():
    _, params, _ = build_semantic_sql(
        DETAIL,
        req(metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[{"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
                      "unit": "day", "count": 7}]),
        max_rows=100, today=date(2026, 8, 15),
    )
    assert params == [date(2026, 8, 9), date(2026, 8, 15)]
```

Append to `backend/tests/test_gateway.py`:

```python
def test_run_query_passes_params_to_the_cursor():
    cur = FakeCursor(rows=[("EAST", 1.0)], description=[FakeCol("REGION"), FakeCol("T")])
    run_query(FakeConnection(cur), "SELECT ... WHERE x = ?", max_rows=10, params=["EAST"])
    assert cur.bound == [["EAST"]]


def test_run_query_without_params_binds_nothing():
    cur = FakeCursor(rows=[], description=[])
    run_query(FakeConnection(cur), "SELECT 1", max_rows=10)
    assert cur.bound == [None]
```

Append to `backend/tests/test_semantic_routes.py`:

```python
def test_a_filtered_query_binds_its_values(client, db):
    conn = login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
            "filters": [{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
                         "values": ["EAST", "WEST"]}],
        },
    )
    assert r.status_code == 200
    cursor = conn.cursor_obj
    select_at = next(
        i for i, s in enumerate(cursor.executed)
        if "SEMANTIC_VIEW" in s and not s.startswith("DESCRIBE")
    )
    assert cursor.bound[select_at] == ["EAST", "WEST"]
    assert "EAST" not in cursor.executed[select_at], "value leaked into SQL text"


def test_an_unknown_filter_operator_is_422(client, db):
    login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "metrics": ["ORDERS.TOTAL_REVENUE"],
            "filters": [{"id": "f1", "field": "CUSTOMERS.REGION", "op": "regex",
                         "values": [".*"]}],
        },
    )
    assert r.status_code == 422


def test_a_filter_on_an_unknown_field_is_400(client, db):
    login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "metrics": ["ORDERS.TOTAL_REVENUE"],
            "filters": [{"id": "f1", "field": "CUSTOMERS.NOPE", "op": "is",
                         "values": ["X"]}],
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == "QUERY_ERROR"
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd backend && python -m pytest tests/test_semantic_query.py tests/test_gateway.py tests/test_semantic_routes.py -v`
Expected: FAIL — `ValueError: too many values to unpack` on the 3-tuple tests, `TypeError: run_query() got an unexpected keyword argument 'params'`, and `Extra inputs are not permitted` for `filters`.

- [ ] **Step 4: Implement — `query.py`**

Add to the imports:

```python
from datetime import date
from typing import Any, Literal

from app.reports.filters import FilterList
from app.semantic.predicates import build_filter_predicates
```

On `SemanticQueryRequest`, after `metrics`:

```python
    #: The effective, already-composed filter set for this query: report
    #: filters AND the visual's own AND any active cross-filter. The client
    #: composes them; the server validates and binds every one.
    filters: FilterList = Field(default_factory=list)
```

Change the signature:

```python
def build_semantic_sql(
    detail: dict, req: SemanticQueryRequest, *, max_rows: int, today: date | None = None
) -> tuple[str, list[Any], int]:
    """Return (sql, params, effective_limit).

    `params` is positional and must be handed to the cursor as-is: it holds
    every filter VALUE, none of which appears in `sql`.
    """
```

After the `METRICS` block (`query.py:56-59`) and before the `selected = dims + mets` line, add:

```python
    # Inside SEMANTIC_VIEW(...), not after it: the predicate has to apply
    # before aggregation, or a KPI card filtered by region would have no
    # REGION column left to filter on. Verified against a real account by
    # the Task 1 spike.
    predicates, params = build_filter_predicates(detail, req.filters, today=today)
    if predicates:
        parts.append("WHERE " + " AND ".join(predicates))
```

Change the final line to `return sql, params, effective_limit`.

- [ ] **Step 5: Implement — `gateway.py`**

Replace the signature and the execute call:

```python
def run_query(
    conn: Any, sql: str, *, max_rows: int, params: list[Any] | None = None
) -> QueryResult:
    cur = conn.cursor()
    try:
        try:
            # Values are bound, never interpolated. `params` is positional and
            # lines up with the placeholders build_semantic_sql emitted.
            if params is not None:
                cur.execute(sql, params)
            else:
                cur.execute(sql)
        except Exception as exc:
            raise map_snowflake_error(exc) from exc
```

Leave the rest of the function unchanged.

- [ ] **Step 6: Implement — `routes.py` and `connect.py`**

In `backend/app/semantic/routes.py:53-56`:

```python
        sql, params, effective_limit = build_semantic_sql(
            detail, req, max_rows=get_settings().row_cap
        )
        result = gateway.run_query(
            entry.conn, sql, max_rows=effective_limit, params=params
        )
```

In `backend/app/snowflake/connect.py`, add `paramstyle="qmark"` to the kwargs of every `snowflake.connector.connect(...)` call (`connect_oauth`, `connect_dev`, `connect_keypair`), with this comment on the first:

```python
        # qmark gives genuine server-side binding for the "?" placeholders
        # predicates.py emits. The default (pyformat) binds client-side --
        # the connector escapes and interpolates, which is strictly weaker.
        paramstyle="qmark",
```

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && python -m pytest -v`
Expected: PASS. Any remaining failure is a caller still unpacking a 2-tuple — `backend/tests/integration/test_snowflake_it.py:86` is one (`sql, limit = build_semantic_sql(...)`); change it to `sql, params, limit = ...` and pass `params=params` to `run_query`.

- [ ] **Step 8: Commit**

```bash
git add backend/app/semantic/query.py backend/app/snowflake/gateway.py backend/app/snowflake/connect.py backend/app/semantic/routes.py backend/tests/
git commit -m "feat: accept filters on the query API and bind their values server-side"
```

---

## Task 5: The distinct-values endpoint

The filter editor needs to offer the values a dimension actually holds. They come from the caller's own connection through the existing gateway, so a user is only ever offered values their Snowflake role can already see.

**Files:**
- Modify: `backend/app/semantic/routes.py`
- Test: `backend/tests/test_semantic_routes.py`

**Interfaces:**
- Consumes: `build_semantic_sql`, `gateway.run_query`, `cache.describe`
- Produces: `GET /api/semantic-views/{database}/{schema}/{name}/values?field=TABLE.FIELD` → `{"values": [str, ...], "truncated": bool}`; `VALUES_CAP = 1000`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_semantic_routes.py`:

```python
def test_distinct_values_for_a_dimension(client, db):
    login(client, db)
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "ORDERS.ORDER_DATE"},
    )
    assert r.status_code == 200
    body = r.json()
    # ScriptedCursor answers every SELECT with two rows whose first column is
    # a date string, so the endpoint's job here is to project column 0.
    assert body["values"] == ["2026-01-01", "2026-01-02"]
    assert body["truncated"] is False


def test_distinct_values_dedupes_and_sorts(client, db):
    conn = login(client, db)
    conn.cursor_obj.value_rows = [("WEST",), ("EAST",), ("WEST",), (None,)]
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION"},
    )
    assert r.json()["values"] == ["EAST", "WEST"], "nulls dropped, duplicates collapsed"


def test_distinct_values_validates_the_field_against_describe(client, db):
    login(client, db)
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.NOPE"},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "QUERY_ERROR"


def test_distinct_values_requires_auth(client):
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values", params={"field": "A.B"}
    )
    assert r.status_code == 401


def test_distinct_values_reports_truncation_at_the_cap(client, db, monkeypatch):
    from app.semantic import routes as semantic_routes

    monkeypatch.setattr(semantic_routes, "VALUES_CAP", 2)
    conn = login(client, db)
    conn.cursor_obj.value_rows = [("A",), ("B",), ("C",)]
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION"},
    )
    body = r.json()
    assert body["values"] == ["A", "B"]
    assert body["truncated"] is True
```

`ScriptedCursor` needs a settable result for plain SELECTs. In its `__init__` add `self.value_rows: list[tuple] | None = None`, and in the `else` branch of `execute`:

```python
        else:
            if self.value_rows is not None:
                self.description = [FakeCol("VALUE", 2)]
                self._rows = list(self.value_rows)
            else:
                self.description = [FakeCol("ORDER_DATE", 3), FakeCol("TOTAL_REVENUE", 0)]
                self._rows = [("2026-01-01", 10.0), ("2026-01-02", 20.0)]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_semantic_routes.py -v -k distinct_values`
Expected: FAIL with 404 on every request — the route does not exist.

- [ ] **Step 3: Implement the endpoint**

Add to `backend/app/semantic/routes.py`, after `describe_view`:

```python
# A picker listing more than a thousand values is not a picker; past this the
# user needs a search box, which is a later feature. The response says so
# rather than silently showing a prefix.
VALUES_CAP = 1000


@router.get("/api/semantic-views/{database}/{schema}/{name}/values")
def field_values(
    database: str,
    schema: str,
    name: str,
    field: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Distinct values of one dimension, for the filter editor.

    Runs on the caller's own connection through the same builder every other
    query uses, so `field` is validated against a live DESCRIBE and emitted
    as a quoted identifier -- it is never interpolated from the query string.
    """
    cache = get_cache()
    entry = cache.acquire(db, sess)
    req = SemanticQueryRequest.model_validate(
        {
            "database": database,
            "schema": schema,
            "view": name,
            "dimensions": [field],
            "limit": VALUES_CAP + 1,
        }
    )
    with entry.lock:
        detail = cache.describe(entry, database, schema, name)
        sql, params, effective_limit = build_semantic_sql(
            detail, req, max_rows=get_settings().row_cap
        )
        result = gateway.run_query(
            entry.conn, sql, max_rows=effective_limit, params=params
        )

    # A semantic view already groups by its selected dimensions, so the rows
    # come back distinct -- dedupe defensively anyway, since that is a
    # property of the model rather than a guarantee of this endpoint.
    seen: set[str] = set()
    for row in result.rows:
        value = row[0] if row else None
        # NULL is dropped: `IN (?)` never matches it, so offering it would
        # produce a filter that silently returns nothing. An explicit
        # is-blank operator is a later feature.
        if value is None:
            continue
        seen.add(str(value))

    values = sorted(seen)
    return {"values": values[:VALUES_CAP], "truncated": len(values) > VALUES_CAP}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && python -m pytest tests/test_semantic_routes.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/semantic/routes.py backend/tests/test_semantic_routes.py
git commit -m "feat: distinct-value endpoint for the filter editor"
```

---

## Task 6: Hierarchy references survive import validation

A well may hold `"hierarchy:h1"` instead of a field. `import_report` re-validates every reference against a live DESCRIBE; today it would see the literal string `hierarchy:h1`, fail to find it, and reject a perfectly good report. It has to expand the reference into the levels behind it and check each one.

**Files:**
- Modify: `backend/app/reports/catalog.py`, `backend/app/reports/service.py:127-131`
- Test: `backend/tests/test_report_catalog.py`, `backend/tests/test_report_import.py`

**Interfaces:**
- Consumes: `app.reports.schema.HIERARCHY_PREFIX`
- Produces: `wells_to_query(visual_type, wells, hierarchies=None) -> tuple[list[str], list[str]]` — the third parameter maps hierarchy id to its ordered levels; a `hierarchy:` ref expands to **all** its levels.

- [ ] **Step 1: Write the failing catalog test**

Append to `backend/tests/test_report_catalog.py`:

```python
from app.reports.catalog import wells_to_query

HIERARCHIES = {"h1": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"]}


def test_wells_to_query_is_unchanged_without_hierarchies():
    dims, mets = wells_to_query(
        "bar", {"axis": ["CUSTOMERS.REGION"], "values": ["ORDERS.TOTAL"]}
    )
    assert dims == ["CUSTOMERS.REGION"]
    assert mets == ["ORDERS.TOTAL"]


def test_a_hierarchy_reference_expands_to_every_level():
    """Import validates each returned ref against DESCRIBE, so every level a
    user could drill to has to be checked -- not just the top one."""
    dims, mets = wells_to_query(
        "bar",
        {"axis": ["hierarchy:h1"], "values": ["ORDERS.TOTAL"]},
        hierarchies=HIERARCHIES,
    )
    assert dims == ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"]
    assert mets == ["ORDERS.TOTAL"]


def test_hierarchy_and_plain_refs_mix_in_declaration_order():
    dims, _ = wells_to_query(
        "bar",
        {"axis": ["hierarchy:h1"], "legend": ["CUSTOMERS.SEGMENT"],
         "values": ["ORDERS.TOTAL"]},
        hierarchies=HIERARCHIES,
    )
    assert dims == [
        "CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY", "CUSTOMERS.SEGMENT"
    ]


def test_an_unknown_hierarchy_reference_is_dropped_rather_than_emitted_raw():
    """`parse_definition` already rejects undeclared hierarchy references, so
    reaching here means the caller passed no map. Emitting "hierarchy:h9" as
    a field reference would produce a confusing "unknown dimension" error."""
    dims, _ = wells_to_query(
        "bar", {"axis": ["hierarchy:h9"], "values": ["ORDERS.TOTAL"]}, hierarchies={}
    )
    assert dims == []
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_report_catalog.py -v`
Expected: FAIL — `TypeError: wells_to_query() got an unexpected keyword argument 'hierarchies'`

- [ ] **Step 3: Implement**

In `backend/app/reports/catalog.py` (`HIERARCHY_PREFIX` already lives here from Task 2), replace `wells_to_query`:

```python
def wells_to_query(
    visual_type: str,
    wells: dict[str, list[str]],
    hierarchies: dict[str, list[str]] | None = None,
) -> tuple[list[str], list[str]]:
    """Flatten a visual's wells into the (dimensions, metrics) the query API takes.

    Order matters: dimensions come out in well-declaration order, so for a bar
    the axis precedes the legend and the caller can rely on that when pivoting.

    A "hierarchy:<id>" entry expands to EVERY level of that hierarchy. Callers
    use this for validation ("can this user see all the fields this report
    could drill to?"), not for querying -- the client picks the single level
    to select from the current drill position before it calls the query API.
    """
    spec = CATALOG[visual_type]
    lookup = hierarchies or {}
    dimensions: list[str] = []
    metrics: list[str] = []
    for well in spec.wells:
        target = dimensions if well.kind == "dimension" else metrics
        for ref in wells.get(well.key, []):
            if ref.startswith(HIERARCHY_PREFIX):
                # An unknown id yields nothing: parse_definition has already
                # rejected undeclared references, so the only way to get here
                # is a caller that passed no map, and emitting the raw
                # "hierarchy:h9" would surface as a bogus unknown-field error.
                target.extend(lookup.get(ref[len(HIERARCHY_PREFIX):], []))
            else:
                target.append(ref)
    return dimensions, metrics
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && python -m pytest tests/test_report_catalog.py -v`
Expected: PASS

- [ ] **Step 4b: Ship the model-first hierarchy detector**

The spec commits to a detector that "returns any hierarchy-shaped objects it finds and an empty list otherwise", so the report-defined path works today and the model path activates by itself if the account ever exposes one. Today's `DESCRIBE` parser recognises only tables, relationships, dimensions, metrics and facts.

Write the failing test in `backend/tests/test_discovery.py`:

```python
from app.semantic.discovery import detect_hierarchies

HIERARCHY_ROWS = DESCRIBE_ROWS + [
    ("HIERARCHY", "GEOGRAPHY", "CUSTOMERS", "LEVELS", "COUNTRY, STATE, CITY"),
]


def test_detect_hierarchies_finds_nothing_in_todays_output():
    """The account this was built against exposes no hierarchies. Returning []
    rather than raising is what lets the report-defined path work unchanged."""
    assert detect_hierarchies(_rows_to_detail(DESCRIBE_ROWS)) == []


def test_detect_hierarchies_reads_a_hierarchy_shaped_object():
    found = detect_hierarchies(_rows_to_detail(HIERARCHY_ROWS))
    assert found == [{
        "id": "model:CUSTOMERS.GEOGRAPHY",
        "name": "GEOGRAPHY",
        "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"],
    }]


def test_detect_hierarchies_skips_one_level_objects():
    """A one-level hierarchy is a plain field; surfacing it as drillable would
    offer a drill that immediately dead-ends."""
    rows = DESCRIBE_ROWS + [
        ("HIERARCHY", "SOLO", "CUSTOMERS", "LEVELS", "COUNTRY"),
    ]
    assert detect_hierarchies(_rows_to_detail(rows)) == []
```

`_rows_to_detail` is a helper in that file that runs `describe_semantic_view` against a `FakeConnection` built from the given rows — reuse the existing one if present, otherwise add it.

Implement in `backend/app/semantic/discovery.py`. `describe_semantic_view` must also collect `HIERARCHY`-kind rows into the detail dict under `hierarchies` (an empty list on every account that has none), and the response model in `frontend/src/api/types.ts` gains `modelHierarchies?: Hierarchy[]`:

```python
def detect_hierarchies(detail: dict) -> list[dict]:
    """Hierarchies the semantic model itself declares, or [] if it declares none.

    Snowflake does not expose hierarchies in DESCRIBE SEMANTIC VIEW on the
    accounts this was built against, so this returns [] today and the
    report-defined path is what works. It is written anyway so the model path
    activates on its own the day an account does expose them -- and so the
    integration probe in Task 14 has something concrete to compare against.
    """
    found: list[dict] = []
    for raw in detail.get("hierarchies", []):
        table = (raw.get("table") or "").strip()
        levels = [
            f"{table}.{part.strip()}" if table else part.strip()
            for part in (raw.get("levels") or "").split(",")
            if part.strip()
        ]
        # Two levels minimum, matching the rule report-defined hierarchies obey.
        if len(levels) < 2:
            continue
        found.append({
            # Namespaced so a model hierarchy can never collide with a
            # report-defined id.
            "id": f"model:{table}.{raw['name']}" if table else f"model:{raw['name']}",
            "name": raw["name"],
            "levels": levels,
        })
    return found
```

Run: `cd backend && python -m pytest tests/test_discovery.py -v` — expect FAIL then PASS.

In `frontend/src/reports/BuilderPage.tsx`, merge the two sources when handing hierarchies down, model first:

```tsx
  // Model-declared hierarchies (none on today's accounts) plus the report's
  // own. Ids are namespaced, so they cannot collide.
  const hierarchies = [
    ...(viewDetail.data?.modelHierarchies ?? []),
    ...(definition.hierarchies ?? []),
  ];
```

- [ ] **Step 5: Write the failing import test**

Append to `backend/tests/test_report_import.py`, following the file's existing client/login/describe fixtures:

```python
def test_import_validates_every_hierarchy_level(client, db):
    """A level the importer's role cannot see must fail the import, not lie
    dormant until someone drills into it."""
    conn = login(client, db)
    body = {
        "definition": {
            "schemaVersion": 2, "name": "Geo",
            "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
            "canvas": {"columns": 12, "rowHeight": 40},
            "filters": [],
            "hierarchies": [{
                "id": "h1", "name": "Geography",
                "levels": ["CUSTOMERS.REGION", "CUSTOMERS.NOPE"],
            }],
            "visuals": [{
                "id": "v1", "type": "bar", "title": "",
                "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                "wells": {"axis": ["hierarchy:h1"], "legend": [],
                          "values": ["ORDERS.TOTAL_REVENUE"]},
                "options": {}, "filters": [],
            }],
        }
    }
    r = client.post("/api/reports/import", json=body)
    assert r.status_code == 400
    assert "CUSTOMERS.NOPE" in r.json()["message"]


def test_import_accepts_a_hierarchy_whose_levels_all_exist(client, db):
    conn = login(client, db)
    body = {
        "definition": {
            "schemaVersion": 2, "name": "Geo",
            "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
            "canvas": {"columns": 12, "rowHeight": 40},
            "filters": [],
            "hierarchies": [{
                "id": "h1", "name": "Geography",
                "levels": ["CUSTOMERS.REGION", "ORDERS.ORDER_DATE"],
            }],
            "visuals": [{
                "id": "v1", "type": "bar", "title": "",
                "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                "wells": {"axis": ["hierarchy:h1"], "legend": [],
                          "values": ["ORDERS.TOTAL_REVENUE"]},
                "options": {}, "filters": [],
            }],
        }
    }
    r = client.post("/api/reports/import", json=body)
    assert r.status_code == 201, r.json()


def test_import_validates_filter_fields_too(client, db):
    """A filter referencing a field the importer cannot see is exactly the
    leak the reference check exists to close."""
    conn = login(client, db)
    body = {
        "definition": {
            "schemaVersion": 2, "name": "Filtered",
            "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
            "canvas": {"columns": 12, "rowHeight": 40},
            "filters": [{"id": "f1", "field": "CUSTOMERS.SECRET", "op": "is",
                         "values": ["X"]}],
            "hierarchies": [], "visuals": [],
        }
    }
    r = client.post("/api/reports/import", json=body)
    assert r.status_code == 400
    assert "CUSTOMERS.SECRET" in r.json()["message"]
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd backend && python -m pytest tests/test_report_import.py -v`
Expected: FAIL — the hierarchy tests fail because `hierarchy:h1` is not expanded (so no level is checked and the bad import is accepted with 201), and the filter test fails because filter fields are never checked at all.

- [ ] **Step 7: Implement in `service.py`**

Replace the reference-collection loop in `import_report` (`service.py:125-139`):

```python
    known = _known_refs(detail)
    hierarchy_levels = {h.id: list(h.levels) for h in definition.hierarchies}

    missing: list[str] = []
    # Report-scope filters first, then each visual's fields and its own
    # filters. A filter reference is exactly as sensitive as a well
    # reference -- both name a field this user's role must be able to see.
    for f in definition.filters:
        if f.field.upper() not in known:
            missing.append(f.field)
    for visual in definition.visuals:
        dimensions, metrics = wells_to_query(
            visual.type, visual.wells, hierarchies=hierarchy_levels
        )
        for ref in dimensions + metrics:
            if ref.upper() not in known:
                missing.append(ref)
        for f in visual.filters:
            if f.field.upper() not in known:
                missing.append(f.field)

    if missing:
        unique = sorted(set(missing))
        raise ApiError(
            "REPORT_INVALID",
            400,
            "This report references fields that do not exist in the target view, "
            "or that your Snowflake role cannot see: " + ", ".join(unique),
        )
```

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && python -m pytest -v`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/app/reports/catalog.py backend/app/reports/schema.py backend/app/reports/service.py backend/tests/
git commit -m "feat: validate hierarchy levels and filter fields on import"
```

---

## Task 7: The frontend filter model — types and pure composition

All the composition logic lives in one React-free module so it can be tested directly. The rule the tests pin down is that filters compose by intersection and a visual never cross-filters itself.

**Files:**
- Modify: `frontend/src/api/types.ts`
- Create: `frontend/src/reports/filters.ts`
- Test: `frontend/src/reports/filters.test.ts`

**Interfaces:**
- Produces (types.ts): `IsFilter`, `BetweenFilter`, `RelativeDateFilter`, `Filter`, `Hierarchy`; `Visual.filters: Filter[]`; `ReportDefinition.filters: Filter[]`, `.hierarchies: Hierarchy[]`; `SemanticQueryBody.filters?: Filter[]`
- Produces (filters.ts): `HIERARCHY_PREFIX`, `DrillStep`, `DrillState`, `CrossFilter`, `hierarchyIdOf`, `hierarchyById`, `resolveWells`, `currentLevel`, `canDrillDown`, `drillFilters`, `effectiveFilters`, `describeFilter`, `newFilterId`

- [ ] **Step 1: Add the wire types**

In `frontend/src/api/types.ts`, add above `ViewRef`:

```ts
export interface IsFilter {
  id: string;
  field: string;
  op: "is" | "isNot";
  values: string[];
}

export interface BetweenFilter {
  id: string;
  field: string;
  op: "between";
  from: string | number;
  to: string | number;
}

export interface RelativeDateFilter {
  id: string;
  field: string;
  op: "relativeDate";
  unit?: "day" | "month" | "year";
  count?: number;
  preset?: "monthToDate" | "yearToDate";
}

export type Filter = IsFilter | BetweenFilter | RelativeDateFilter;

export interface Hierarchy {
  id: string;
  name: string;
  levels: string[];
}

export interface FieldValuesResponse {
  values: string[];
  truncated: boolean;
}
```

Add `filters: Filter[];` to `Visual`; add `filters: Filter[];` and `hierarchies: Hierarchy[];` to `ReportDefinition`; add `filters?: Filter[];` to `SemanticQueryBody`.

- [ ] **Step 2: Write the failing test**

```ts
// frontend/src/reports/filters.test.ts
import { describe, expect, it } from "vitest";
import type { Filter, Hierarchy, Visual } from "../api/types";
import {
  canDrillDown,
  currentLevel,
  describeFilter,
  drillFilters,
  effectiveFilters,
  hierarchyIdOf,
  resolveWells,
} from "./filters";

const GEO: Hierarchy = {
  id: "h1",
  name: "Geography",
  levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"],
};

const REGION_IS_EAST: Filter = {
  id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"],
};

function visual(overrides: Partial<Visual> = {}): Visual {
  return {
    id: "v1", type: "bar", title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["CUSTOMERS.REGION"], legend: [], values: ["ORDERS.TOTAL"] },
    options: {}, filters: [],
    ...overrides,
  };
}

describe("hierarchyIdOf", () => {
  it("reads the id out of a hierarchy reference", () => {
    expect(hierarchyIdOf("hierarchy:h1")).toBe("h1");
  });

  it("returns null for a plain field reference", () => {
    expect(hierarchyIdOf("CUSTOMERS.REGION")).toBeNull();
  });
});

describe("resolveWells", () => {
  it("leaves plain references alone", () => {
    const wells = { axis: ["CUSTOMERS.REGION"], values: ["ORDERS.TOTAL"] };
    expect(resolveWells(wells, [GEO], undefined)).toEqual(wells);
  });

  it("resolves a hierarchy reference to its top level when undrilled", () => {
    const out = resolveWells(
      { axis: ["hierarchy:h1"], values: ["ORDERS.TOTAL"] }, [GEO], undefined,
    );
    expect(out.axis).toEqual(["CUSTOMERS.COUNTRY"]);
  });

  it("resolves to the level matching the drill depth", () => {
    const out = resolveWells(
      { axis: ["hierarchy:h1"], values: ["ORDERS.TOTAL"] },
      [GEO],
      { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
    );
    expect(out.axis).toEqual(["CUSTOMERS.STATE"]);
  });

  it("clamps to the last level rather than running off the end", () => {
    const out = resolveWells(
      { axis: ["hierarchy:h1"], values: ["ORDERS.TOTAL"] },
      [GEO],
      { hierarchyId: "h1", path: [
        { field: "CUSTOMERS.COUNTRY", value: "US" },
        { field: "CUSTOMERS.STATE", value: "CA" },
        { field: "CUSTOMERS.CITY", value: "SF" },
      ] },
    );
    expect(out.axis).toEqual(["CUSTOMERS.CITY"]);
  });

  it("drops a reference to a hierarchy the report no longer declares", () => {
    const out = resolveWells({ axis: ["hierarchy:gone"], values: [] }, [GEO], undefined);
    expect(out.axis).toEqual([]);
  });

  it("ignores a drill state belonging to a different hierarchy", () => {
    const out = resolveWells(
      { axis: ["hierarchy:h1"], values: [] },
      [GEO],
      { hierarchyId: "other", path: [{ field: "X.Y", value: "1" }] },
    );
    expect(out.axis).toEqual(["CUSTOMERS.COUNTRY"]);
  });
});

describe("currentLevel / canDrillDown", () => {
  it("reports the level for a depth", () => {
    expect(currentLevel(GEO, 0)).toBe("CUSTOMERS.COUNTRY");
    expect(currentLevel(GEO, 2)).toBe("CUSTOMERS.CITY");
  });

  it("allows drilling until the last level", () => {
    expect(canDrillDown(GEO, 0)).toBe(true);
    expect(canDrillDown(GEO, 1)).toBe(true);
    expect(canDrillDown(GEO, 2)).toBe(false);
  });
});

describe("drillFilters", () => {
  it("produces nothing at the top level", () => {
    expect(drillFilters(undefined)).toEqual([]);
    expect(drillFilters({ hierarchyId: "h1", path: [] })).toEqual([]);
  });

  it("produces one equality filter per level already traversed", () => {
    const out = drillFilters({
      hierarchyId: "h1",
      path: [
        { field: "CUSTOMERS.COUNTRY", value: "US" },
        { field: "CUSTOMERS.STATE", value: "CA" },
      ],
    });
    expect(out).toEqual([
      { id: "drill:CUSTOMERS.COUNTRY", field: "CUSTOMERS.COUNTRY", op: "is", values: ["US"] },
      { id: "drill:CUSTOMERS.STATE", field: "CUSTOMERS.STATE", op: "is", values: ["CA"] },
    ]);
  });

  it("uses ids derived from the field so the query key stays stable", () => {
    const a = drillFilters({ hierarchyId: "h1", path: [{ field: "F", value: "1" }] });
    const b = drillFilters({ hierarchyId: "h1", path: [{ field: "F", value: "1" }] });
    expect(a).toEqual(b);
  });
});

describe("effectiveFilters", () => {
  it("intersects report scope and visual scope, report first", () => {
    const own: Filter = { id: "f2", field: "ORDERS.CHANNEL", op: "is", values: ["WEB"] };
    const out = effectiveFilters({
      reportFilters: [REGION_IS_EAST],
      visual: visual({ filters: [own] }),
    });
    expect(out).toEqual([REGION_IS_EAST, own]);
  });

  it("appends the drill path", () => {
    const out = effectiveFilters({
      reportFilters: [],
      visual: visual(),
      drill: { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
    });
    expect(out).toHaveLength(1);
    expect(out[0].field).toBe("CUSTOMERS.COUNTRY");
  });

  it("applies a cross-filter from another visual", () => {
    const out = effectiveFilters({
      reportFilters: [],
      visual: visual(),
      crossFilter: { sourceVisualId: "v2", field: "CUSTOMERS.REGION", value: "EAST" },
    });
    expect(out).toEqual([
      { id: "xf:CUSTOMERS.REGION", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
    ]);
  });

  it("never cross-filters the visual the selection came from", () => {
    const out = effectiveFilters({
      reportFilters: [],
      visual: visual({ id: "v2" }),
      crossFilter: { sourceVisualId: "v2", field: "CUSTOMERS.REGION", value: "EAST" },
    });
    expect(out).toEqual([]);
  });

  it("keeps every scope when all four are present", () => {
    const own: Filter = { id: "f2", field: "ORDERS.CHANNEL", op: "is", values: ["WEB"] };
    const out = effectiveFilters({
      reportFilters: [REGION_IS_EAST],
      visual: visual({ filters: [own] }),
      drill: { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
      crossFilter: { sourceVisualId: "v9", field: "ORDERS.SEGMENT", value: "SMB" },
    });
    expect(out.map((f) => f.field)).toEqual([
      "CUSTOMERS.REGION", "ORDERS.CHANNEL", "CUSTOMERS.COUNTRY", "ORDERS.SEGMENT",
    ]);
  });
});

describe("describeFilter", () => {
  it("summarises an is filter", () => {
    expect(describeFilter(REGION_IS_EAST)).toBe("CUSTOMERS.REGION is EAST");
  });

  it("counts a multi-value is filter rather than listing everything", () => {
    expect(
      describeFilter({ id: "f", field: "F", op: "is", values: ["A", "B", "C"] }),
    ).toBe("F is 3 values");
  });

  it("summarises isNot, between and relativeDate", () => {
    expect(describeFilter({ id: "f", field: "F", op: "isNot", values: ["A"] }))
      .toBe("F is not A");
    expect(describeFilter({ id: "f", field: "F", op: "between", from: 1, to: 9 }))
      .toBe("F is between 1 and 9");
    expect(describeFilter({ id: "f", field: "F", op: "relativeDate", unit: "day", count: 30 }))
      .toBe("F in the last 30 days");
    expect(describeFilter({ id: "f", field: "F", op: "relativeDate", preset: "monthToDate" }))
      .toBe("F month to date");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/reports/filters.test.ts`
Expected: FAIL — cannot resolve `./filters`

- [ ] **Step 4: Write the module**

```ts
// frontend/src/reports/filters.ts
// Composition rules for filters, hierarchies and drill state. Deliberately
// React-free: what a visual's effective filter set IS can then be asserted
// directly, without rendering anything.

import type { Filter, Hierarchy, Visual } from "../api/types";

/** A well entry of this shape stands in for a whole drill path, not a field.
 *  Mirrors HIERARCHY_PREFIX in backend/app/reports/catalog.py. */
export const HIERARCHY_PREFIX = "hierarchy:";

export interface DrillStep {
  field: string;
  value: string;
}

/** Where one visual currently sits in a hierarchy. Ephemeral by design — held
 *  in component state, never written to the definition — so a saved report
 *  always opens at the top level and can never point at a value that has
 *  since disappeared. */
export interface DrillState {
  hierarchyId: string;
  path: DrillStep[];
}

/** A selection made by clicking a mark. Also ephemeral. */
export interface CrossFilter {
  sourceVisualId: string;
  field: string;
  value: string;
}

export function hierarchyIdOf(ref: string): string | null {
  return ref.startsWith(HIERARCHY_PREFIX) ? ref.slice(HIERARCHY_PREFIX.length) : null;
}

export function hierarchyById(hierarchies: Hierarchy[], id: string): Hierarchy | undefined {
  return hierarchies.find((h) => h.id === id);
}

export function currentLevel(hierarchy: Hierarchy, depth: number): string {
  // Clamped: a drill path can only ever be as deep as the hierarchy is long,
  // but clamping here means a stale path renders the deepest level rather
  // than `undefined`.
  const index = Math.min(depth, hierarchy.levels.length - 1);
  return hierarchy.levels[index];
}

export function canDrillDown(hierarchy: Hierarchy, depth: number): boolean {
  return depth < hierarchy.levels.length - 1;
}

/** Replace hierarchy references with the single field the visual should select
 *  right now. This is what the query API receives — it never sees a hierarchy. */
export function resolveWells(
  wells: Record<string, string[]>,
  hierarchies: Hierarchy[],
  drill: DrillState | undefined,
): Record<string, string[]> {
  const resolved: Record<string, string[]> = {};
  for (const [key, refs] of Object.entries(wells)) {
    resolved[key] = refs.flatMap((ref) => {
      const id = hierarchyIdOf(ref);
      if (id === null) return [ref];
      const hierarchy = hierarchyById(hierarchies, id);
      // A reference to a hierarchy that no longer exists yields nothing; the
      // visual then fails its own well validation and says so, which beats
      // sending "hierarchy:gone" to the server as a field name.
      if (!hierarchy) return [];
      const depth = drill?.hierarchyId === id ? drill.path.length : 0;
      return [currentLevel(hierarchy, depth)];
    });
  }
  return resolved;
}

/** One equality filter per level already drilled through. */
export function drillFilters(drill: DrillState | undefined): Filter[] {
  if (!drill) return [];
  return drill.path.map((step) => ({
    // Derived from the field rather than randomly generated: these end up in
    // the TanStack Query key, and a fresh id each render would make every
    // key unique and defeat caching entirely.
    id: `drill:${step.field}`,
    field: step.field,
    op: "is" as const,
    values: [step.value],
  }));
}

/** The composed filter set for one visual: report scope AND its own AND the
 *  drill path AND any active cross-filter. Intersection, in that order. */
export function effectiveFilters({
  reportFilters,
  visual,
  drill,
  crossFilter,
}: {
  reportFilters: Filter[];
  visual: Visual;
  drill?: DrillState;
  crossFilter?: CrossFilter | null;
}): Filter[] {
  const composed: Filter[] = [
    ...reportFilters,
    ...(visual.filters ?? []),
    ...drillFilters(drill),
  ];
  // A visual filtering itself by its own selection would collapse to the one
  // clicked mark the moment you clicked it.
  if (crossFilter && crossFilter.sourceVisualId !== visual.id) {
    composed.push({
      id: `xf:${crossFilter.field}`,
      field: crossFilter.field,
      op: "is",
      values: [crossFilter.value],
    });
  }
  return composed;
}

const UNIT_LABEL: Record<string, string> = { day: "days", month: "months", year: "years" };

/** A short human summary for filter chips and list rows. */
export function describeFilter(filter: Filter): string {
  if (filter.op === "is" || filter.op === "isNot") {
    const verb = filter.op === "is" ? "is" : "is not";
    const what =
      filter.values.length === 1 ? filter.values[0] : `${filter.values.length} values`;
    return `${filter.field} ${verb} ${what}`;
  }
  if (filter.op === "between") {
    return `${filter.field} is between ${filter.from} and ${filter.to}`;
  }
  if (filter.preset === "monthToDate") return `${filter.field} month to date`;
  if (filter.preset === "yearToDate") return `${filter.field} year to date`;
  return `${filter.field} in the last ${filter.count} ${UNIT_LABEL[filter.unit ?? "day"]}`;
}

/** Ids only need to be unique within one report, and `crypto.randomUUID` is
 *  already how visual ids are minted in BuilderPage. */
export function newFilterId(): string {
  return `f${crypto.randomUUID().slice(0, 8)}`;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/reports/filters.test.ts && npx tsc --noEmit`
Expected: PASS. `tsc` will flag every place that builds a `Visual` or `ReportDefinition` without the new required fields — fix those by adding `filters: []` / `hierarchies: []` (in `BuilderPage.addVisual`, `ReportListPage`'s blank definition, and existing test fixtures). Do not make the fields optional to silence it: they are required on the wire.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/reports/filters.ts frontend/src/reports/filters.test.ts
git commit -m "feat: frontend filter, hierarchy and drill model"
```

---

## Task 8: `useVisualQuery` sends filters and keys on them

The single most likely bug in this phase: a filtered tile serving the unfiltered result it cached moments earlier. The fix is that everything affecting the result is in the query key.

**Files:**
- Modify: `frontend/src/reports/useVisualQuery.ts`
- Test: `frontend/src/reports/useVisualQuery.test.ts` (create)

**Interfaces:**
- Consumes: `effectiveFilters`, `resolveWells` from `./filters`
- Produces: `useVisualQuery(view, visual, opts?)` where `opts = { reportFilters?: Filter[]; hierarchies?: Hierarchy[]; drill?: DrillState; crossFilter?: CrossFilter | null }`; returns `{ problems, ready, filters, query }`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/reports/useVisualQuery.test.ts
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hierarchy, ViewRef, Visual } from "../api/types";
import { useVisualQuery } from "./useVisualQuery";

const VIEW: ViewRef = { database: "D", schema: "S", name: "V" };

const GEO: Hierarchy = {
  id: "h1", name: "Geography",
  levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE"],
};

function visual(overrides: Partial<Visual> = {}): Visual {
  return {
    id: "v1", type: "bar", title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["CUSTOMERS.REGION"], legend: [], values: ["ORDERS.TOTAL"] },
    options: {}, filters: [],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function lastBody() {
  return JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ columns: [], rows: [], truncated: false, sfqid: "q", sql: "" }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVisualQuery", () => {
  it("sends no filters when there are none", async () => {
    renderHook(() => useVisualQuery(VIEW, visual()), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastBody().filters).toEqual([]);
  });

  it("sends the composed filter set", async () => {
    renderHook(
      () =>
        useVisualQuery(VIEW, visual(), {
          reportFilters: [
            { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
          ],
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastBody().filters).toEqual([
      { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
    ]);
  });

  it("refetches when a filter changes rather than serving the cached result", async () => {
    const { rerender } = renderHook(
      ({ region }: { region: string }) =>
        useVisualQuery(VIEW, visual(), {
          reportFilters: [
            { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [region] },
          ],
        }),
      { wrapper, initialProps: { region: "EAST" } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ region: "WEST" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastBody().filters[0].values).toEqual(["WEST"]);
  });

  it("does not refetch when nothing that affects the result changed", async () => {
    const { rerender } = renderHook(
      ({ title }: { title: string }) => useVisualQuery(VIEW, visual({ title })),
      { wrapper, initialProps: { title: "A" } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ title: "B" });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("selects the drilled level, and refetches when the drill advances", async () => {
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        useVisualQuery(VIEW, visual({ wells: { axis: ["hierarchy:h1"], legend: [], values: ["ORDERS.TOTAL"] } }), {
          hierarchies: [GEO],
          drill: {
            hierarchyId: "h1",
            path: depth ? [{ field: "CUSTOMERS.COUNTRY", value: "US" }] : [],
          },
        }),
      { wrapper, initialProps: { depth: 0 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastBody().dimensions).toEqual(["CUSTOMERS.COUNTRY"]);

    rerender({ depth: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastBody().dimensions).toEqual(["CUSTOMERS.STATE"]);
    expect(lastBody().filters).toEqual([
      { id: "drill:CUSTOMERS.COUNTRY", field: "CUSTOMERS.COUNTRY", op: "is", values: ["US"] },
    ]);
  });

  it("refetches when a cross-filter selection appears", async () => {
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) =>
        useVisualQuery(VIEW, visual(), {
          crossFilter: on
            ? { sourceVisualId: "v2", field: "CUSTOMERS.REGION", value: "EAST" }
            : null,
        }),
      { wrapper, initialProps: { on: false } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ on: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastBody().filters[0].values).toEqual(["EAST"]);
  });

  it("stays disabled while the wells are invalid", () => {
    const { result } = renderHook(
      () => useVisualQuery(VIEW, visual({ wells: { axis: [], legend: [], values: [] } })),
      { wrapper },
    );
    expect(result.current.ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

Rename the file to `.tsx` if the JSX wrapper trips the test runner's loader — check whether `frontend/src` already uses `.test.tsx` for hook tests and follow that.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/reports/useVisualQuery.test.tsx`
Expected: FAIL — `useVisualQuery` takes two arguments, so the options are ignored and `filters` is absent from every body.

- [ ] **Step 3: Rewrite the hook**

```ts
// frontend/src/reports/useVisualQuery.ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { Filter, Hierarchy, QueryResponse, ViewRef, Visual } from "../api/types";
import { validateWells, wellsToQuery, type VisualType } from "./catalog";
import { effectiveFilters, resolveWells, type CrossFilter, type DrillState } from "./filters";

interface Options {
  reportFilters?: Filter[];
  hierarchies?: Hierarchy[];
  drill?: DrillState;
  crossFilter?: CrossFilter | null;
}

/** One query per visual, so tiles render progressively and one slow visual
 *  cannot block the page. Disabled until the wells are actually valid. */
export function useVisualQuery(view: ViewRef, visual: Visual, options: Options = {}) {
  const { reportFilters = [], hierarchies = [], drill, crossFilter = null } = options;
  const type = visual.type as VisualType;

  // Hierarchy references resolve to a single field first: well validation and
  // the query itself both work in terms of real fields.
  const wells = resolveWells(visual.wells, hierarchies, drill);
  const problems = validateWells(type, wells);
  const ready = problems.length === 0 && Boolean(view.name);
  const { dimensions, metrics } = wellsToQuery(type, wells);
  const filters = effectiveFilters({ reportFilters, visual, drill, crossFilter });

  return {
    problems,
    ready,
    filters,
    query: useQuery({
      // Everything that changes the RESULT is in the key. Leave any of it out
      // and a filtered tile serves the unfiltered result it cached moments
      // earlier -- which looks like a rendering bug and is not one.
      // `visual.type` and `wells` (not `visual.wells`) rather than the whole
      // visual: renaming a tile must not refetch it.
      queryKey: ["visual-query", view, visual.type, wells, filters],
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
            filters,
          }),
        }),
    }),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/reports/useVisualQuery.test.tsx && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/reports/useVisualQuery.ts frontend/src/reports/useVisualQuery.test.tsx
git commit -m "feat: send composed filters from each visual and key the cache on them"
```

---

## Task 9: The filter editor

One filter's editor. It offers only the operators that make sense for the field's type, and for `is`/`isNot` it fetches the real values from the account.

**Files:**
- Create: `frontend/src/reports/useFieldValues.ts`, `frontend/src/reports/FilterEditor.tsx`
- Test: `frontend/src/reports/FilterEditor.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `describeFilter`, `newFilterId`, `FieldValuesResponse`
- Produces:
  - `useFieldValues(view: ViewRef, field: string | null)` → TanStack query of `FieldValuesResponse`
  - `operatorsFor(dataType: string | null): FilterOp[]`
  - `<FilterEditor field filter view onChange onRemove />`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/reports/FilterEditor.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldInfo, Filter, ViewRef } from "../api/types";
import FilterEditor, { operatorsFor } from "./FilterEditor";

const VIEW: ViewRef = { database: "D", schema: "S", name: "V" };
const REGION: FieldInfo = { table: "CUSTOMERS", name: "REGION", dataType: "VARCHAR(16777216)" };
const ORDER_DATE: FieldInfo = { table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" };
const AMOUNT: FieldInfo = { table: "ORDERS", name: "AMOUNT", dataType: "NUMBER(38,2)" };

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ values: ["EAST", "NORTH", "SOUTH", "WEST"], truncated: false }),
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("operatorsFor", () => {
  it("offers equality and range on a date", () => {
    expect(operatorsFor("DATE")).toEqual(["is", "isNot", "between", "relativeDate"]);
  });

  it("offers no relative-date option on text", () => {
    expect(operatorsFor("VARCHAR(16777216)")).toEqual(["is", "isNot"]);
  });

  it("offers between on a number but not relativeDate", () => {
    expect(operatorsFor("NUMBER(38,2)")).toEqual(["is", "isNot", "between"]);
  });

  it("falls back to equality when the type is unknown", () => {
    expect(operatorsFor(null)).toEqual(["is", "isNot"]);
  });
});

describe("FilterEditor", () => {
  const noop = () => {};

  it("lists only the operators valid for the field type", () => {
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(<FilterEditor field={REGION} filter={filter} view={VIEW} onChange={noop} onRemove={noop} />);
    const select = screen.getByLabelText(/operator/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["is", "isNot"]);
  });

  it("offers the field's real values as checkboxes", async () => {
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(<FilterEditor field={REGION} filter={filter} view={VIEW} onChange={noop} onRemove={noop} />);
    expect(await screen.findByRole("checkbox", { name: "EAST" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "WEST" })).toBeInTheDocument();
  });

  it("emits the selected values", async () => {
    const onChange = vi.fn();
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(<FilterEditor field={REGION} filter={filter} view={VIEW} onChange={onChange} onRemove={noop} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "EAST" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ op: "is", values: ["EAST"] }),
    );
  });

  it("switching operator to between swaps in from/to inputs", async () => {
    const onChange = vi.fn();
    const filter: Filter = { id: "f1", field: "ORDERS.AMOUNT", op: "is", values: ["1"] };
    wrap(<FilterEditor field={AMOUNT} filter={filter} view={VIEW} onChange={onChange} onRemove={noop} />);
    await userEvent.selectOptions(screen.getByLabelText(/operator/i), "between");
    // The editor rewrites the whole filter rather than keeping stale `values`,
    // which would fail the backend's discriminated union.
    expect(onChange).toHaveBeenCalledWith({
      id: "f1", field: "ORDERS.AMOUNT", op: "between", from: "", to: "",
    });
  });

  it("offers relative-date presets on a date field", async () => {
    const filter: Filter = {
      id: "f1", field: "ORDERS.ORDER_DATE", op: "relativeDate", unit: "day", count: 30,
    };
    wrap(<FilterEditor field={ORDER_DATE} filter={filter} view={VIEW} onChange={noop} onRemove={noop} />);
    expect(screen.getByLabelText(/last/i)).toHaveValue(30);
    expect(screen.getByLabelText(/unit/i)).toBeInTheDocument();
  });

  it("does not fetch values for an operator that takes none", () => {
    const filter: Filter = {
      id: "f1", field: "ORDERS.ORDER_DATE", op: "relativeDate", preset: "monthToDate",
    };
    wrap(<FilterEditor field={ORDER_DATE} filter={filter} view={VIEW} onChange={noop} onRemove={noop} />);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so when the value list was capped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ values: ["A"], truncated: true }),
    }));
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(<FilterEditor field={REGION} filter={filter} view={VIEW} onChange={noop} onRemove={noop} />);
    expect(await screen.findByText(/showing the first/i)).toBeInTheDocument();
  });

  it("removes itself", async () => {
    const onRemove = vi.fn();
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(<FilterEditor field={REGION} filter={filter} view={VIEW} onChange={noop} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /remove filter/i }));
    expect(onRemove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/reports/FilterEditor.test.tsx`
Expected: FAIL — cannot resolve `./FilterEditor`

- [ ] **Step 3: Write `useFieldValues`**

```ts
// frontend/src/reports/useFieldValues.ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { FieldValuesResponse, ViewRef } from "../api/types";

/** Distinct values of one dimension, for the filter editor's value picker.
 *  Runs on the caller's own Snowflake connection, so a user is only ever
 *  offered values their role can already read. */
export function useFieldValues(view: ViewRef, field: string | null) {
  return useQuery({
    queryKey: ["field-values", view, field],
    enabled: Boolean(view.name && field),
    // Values change far more slowly than the filter editor opens and closes,
    // and each fetch is a real Snowflake query.
    staleTime: 5 * 60 * 1000,
    queryFn: () => {
      const base = `/api/semantic-views/${encodeURIComponent(view.database)}/${encodeURIComponent(
        view.schema,
      )}/${encodeURIComponent(view.name)}/values`;
      return apiFetch<FieldValuesResponse>(`${base}?field=${encodeURIComponent(field ?? "")}`);
    },
  });
}
```

- [ ] **Step 4: Write `FilterEditor`**

```tsx
// frontend/src/reports/FilterEditor.tsx
import type { FieldInfo, Filter, ViewRef } from "../api/types";
import { describeFilter } from "./filters";
import { useFieldValues } from "./useFieldValues";

export type FilterOp = Filter["op"];

const OP_LABEL: Record<FilterOp, string> = {
  is: "is",
  isNot: "is not",
  between: "is between",
  relativeDate: "in the last",
};

function isDate(dataType: string | null): boolean {
  const t = (dataType ?? "").toUpperCase();
  return t.startsWith("DATE") || t.startsWith("TIMESTAMP");
}

function isNumeric(dataType: string | null): boolean {
  const t = (dataType ?? "").toUpperCase();
  return (
    t.startsWith("NUMBER") || t.startsWith("DECIMAL") || t.startsWith("INT") ||
    t.startsWith("FLOAT") || t.startsWith("DOUBLE") || t.startsWith("REAL")
  );
}

/** Which operators make sense for a field of this type. Offering `between` on
 *  free text, or a relative-date window on a string, produces filters that
 *  are valid but meaningless. */
export function operatorsFor(dataType: string | null): FilterOp[] {
  if (isDate(dataType)) return ["is", "isNot", "between", "relativeDate"];
  if (isNumeric(dataType)) return ["is", "isNot", "between"];
  return ["is", "isNot"];
}

/** Rebuild the filter from scratch on an operator change.

 *  Carrying `values` into a `between` filter would produce a shape the
 *  backend's discriminated union rejects (`extra="forbid"`), so the whole
 *  record is replaced rather than spread over. */
function withOperator(filter: Filter, op: FilterOp): Filter {
  const base = { id: filter.id, field: filter.field };
  if (op === "is" || op === "isNot") return { ...base, op, values: [] };
  if (op === "between") return { ...base, op, from: "", to: "" };
  return { ...base, op, unit: "day", count: 30 };
}

interface Props {
  field: FieldInfo | null;
  filter: Filter;
  view: ViewRef;
  onChange: (next: Filter) => void;
  onRemove: () => void;
}

export default function FilterEditor({ field, filter, view, onChange, onRemove }: Props) {
  const operators = operatorsFor(field?.dataType ?? null);
  const wantsValues = filter.op === "is" || filter.op === "isNot";
  const values = useFieldValues(view, wantsValues ? filter.field : null);
  const chosen = wantsValues ? filter.values : [];

  const toggle = (value: string) => {
    if (!wantsValues) return;
    const next = chosen.includes(value)
      ? chosen.filter((v) => v !== value)
      : [...chosen, value];
    onChange({ ...filter, values: next });
  };

  return (
    <div className="filter-editor">
      <div className="filter-editor-head">
        {/* The summary, not just the field name: with two scopes on screen at
            once, "CUSTOMERS.REGION" alone does not tell you what it is doing. */}
        <span className="filter-field">{describeFilter(filter)}</span>
        <button type="button" className="link" onClick={onRemove}>
          Remove filter
        </button>
      </div>

      <label>
        Operator
        <select
          value={filter.op}
          onChange={(e) => onChange(withOperator(filter, e.target.value as FilterOp))}
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op]}
            </option>
          ))}
        </select>
      </label>

      {wantsValues && (
        <div className="filter-values">
          {values.isLoading && <p className="tile-hint">Loading values…</p>}
          {values.isError && (
            <p role="alert">Could not load values for this field.</p>
          )}
          {values.data?.values.map((value) => (
            <label key={value} className="filter-value">
              <input
                type="checkbox"
                checked={chosen.includes(value)}
                onChange={() => toggle(value)}
              />
              {value}
            </label>
          ))}
          {values.data?.truncated && (
            <p className="tile-hint">
              Showing the first {values.data.values.length} values. Narrow the field
              or use a different operator.
            </p>
          )}
        </div>
      )}

      {filter.op === "between" && (
        <div className="filter-range">
          <label>
            From
            <input
              value={String(filter.from)}
              onChange={(e) => onChange({ ...filter, from: e.target.value })}
            />
          </label>
          <label>
            To
            <input
              value={String(filter.to)}
              onChange={(e) => onChange({ ...filter, to: e.target.value })}
            />
          </label>
        </div>
      )}

      {filter.op === "relativeDate" && (
        <div className="filter-relative">
          <label>
            Last
            <input
              type="number"
              min={1}
              value={filter.count ?? 30}
              onChange={(e) =>
                onChange({
                  ...filter, preset: undefined,
                  unit: filter.unit ?? "day", count: Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Unit
            <select
              value={filter.unit ?? "day"}
              onChange={(e) =>
                onChange({
                  ...filter, preset: undefined,
                  unit: e.target.value as "day" | "month" | "year",
                  count: filter.count ?? 30,
                })
              }
            >
              <option value="day">days</option>
              <option value="month">months</option>
              <option value="year">years</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/reports/FilterEditor.test.tsx && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/reports/useFieldValues.ts frontend/src/reports/FilterEditor.tsx frontend/src/reports/FilterEditor.test.tsx
git commit -m "feat: filter editor with type-aware operators and real value lists"
```

---

## Task 10: The Filters pane, wired into the builder

The pane joins the builder's right-hand stack beneath Fields. It shows report-scope filters and, when a visual is selected, that visual's own — with each scope clearly labelled, because "why is this tile different from its neighbour" is the question a two-scope model invites.

**Files:**
- Create: `frontend/src/reports/FilterPane.tsx`
- Modify: `frontend/src/reports/BuilderPage.tsx`, `frontend/src/reports/CanvasGrid.tsx`, `frontend/src/reports/VisualTile.tsx`, `frontend/src/index.css`
- Test: `frontend/src/reports/FilterPane.test.tsx`, `frontend/src/reports/BuilderPage.test.tsx`

**Interfaces:**
- Consumes: `FilterEditor`, `describeFilter`, `newFilterId`
- Produces: `<FilterPane view fields reportFilters visualFilters selectedVisualTitle onChangeReport onChangeVisual />`; `VisualTile` and `CanvasGrid` gain `reportFilters`, `hierarchies`, `drill`, `crossFilter` props

- [ ] **Step 1: Write the failing pane test**

```tsx
// frontend/src/reports/FilterPane.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldInfo, Filter, ViewRef } from "../api/types";
import FilterPane from "./FilterPane";

const VIEW: ViewRef = { database: "D", schema: "S", name: "V" };
const FIELDS: FieldInfo[] = [
  { table: "CUSTOMERS", name: "REGION", dataType: "VARCHAR(16777216)" },
  { table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" },
];

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const props = {
  view: VIEW, fields: FIELDS, reportFilters: [] as Filter[],
  visualFilters: null as Filter[] | null, selectedVisualTitle: null as string | null,
  onChangeReport: () => {}, onChangeVisual: () => {},
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ values: ["EAST"], truncated: false }),
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("FilterPane", () => {
  it("says the report has no filters yet", () => {
    wrap(<FilterPane {...props} />);
    expect(screen.getByText(/no filters on this report/i)).toBeInTheDocument();
  });

  it("adds a report-scope filter for a chosen field", async () => {
    const onChangeReport = vi.fn();
    wrap(<FilterPane {...props} onChangeReport={onChangeReport} />);
    await userEvent.selectOptions(
      screen.getByLabelText(/add a filter on this report/i), "CUSTOMERS.REGION",
    );
    expect(onChangeReport).toHaveBeenCalledWith([
      expect.objectContaining({ field: "CUSTOMERS.REGION", op: "is", values: [] }),
    ]);
  });

  it("labels the two scopes distinctly", () => {
    wrap(
      <FilterPane
        {...props}
        reportFilters={[{ id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] }]}
        visualFilters={[]}
        selectedVisualTitle="Revenue by region"
      />,
    );
    expect(screen.getByRole("heading", { name: /filters on this report/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /filters on "Revenue by region"/i }))
      .toBeInTheDocument();
  });

  it("hides the visual scope when no visual is selected", () => {
    wrap(<FilterPane {...props} visualFilters={null} />);
    expect(screen.queryByText(/filters on this visual/i)).not.toBeInTheDocument();
  });

  it("removes a filter", async () => {
    const onChangeReport = vi.fn();
    wrap(
      <FilterPane
        {...props}
        reportFilters={[{ id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] }]}
        onChangeReport={onChangeReport}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove filter/i }));
    expect(onChangeReport).toHaveBeenCalledWith([]);
  });

  it("does not offer a field that is already filtered at this scope", () => {
    wrap(
      <FilterPane
        {...props}
        reportFilters={[{ id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] }]}
      />,
    );
    const select = screen.getByLabelText(/add a filter on this report/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).not.toContain("CUSTOMERS.REGION");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/reports/FilterPane.test.tsx`
Expected: FAIL — cannot resolve `./FilterPane`

- [ ] **Step 3: Write the pane**

```tsx
// frontend/src/reports/FilterPane.tsx
import type { FieldInfo, Filter, ViewRef } from "../api/types";
import FilterEditor from "./FilterEditor";
import { newFilterId } from "./filters";

interface Props {
  view: ViewRef;
  fields: FieldInfo[];
  reportFilters: Filter[];
  /** null when no visual is selected — the visual scope is then hidden. */
  visualFilters: Filter[] | null;
  selectedVisualTitle: string | null;
  onChangeReport: (next: Filter[]) => void;
  onChangeVisual: (next: Filter[]) => void;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

function FilterScope({
  heading, emptyText, addLabel, filters, fields, view, onChange,
}: {
  heading: string;
  emptyText: string;
  addLabel: string;
  filters: Filter[];
  fields: FieldInfo[];
  view: ViewRef;
  onChange: (next: Filter[]) => void;
}) {
  const filtered = new Set(filters.map((f) => f.field));
  const available = fields.filter((f) => !filtered.has(refOf(f)));

  const add = (ref: string) => {
    if (!ref) return;
    onChange([...filters, { id: newFilterId(), field: ref, op: "is", values: [] }]);
  };

  return (
    <div className="filter-scope">
      <h4>{heading}</h4>
      {filters.length === 0 && <p className="tile-hint">{emptyText}</p>}
      {filters.map((filter, index) => (
        <FilterEditor
          key={filter.id}
          view={view}
          filter={filter}
          field={fields.find((f) => refOf(f) === filter.field) ?? null}
          onChange={(next) =>
            onChange(filters.map((f, i) => (i === index ? next : f)))
          }
          onRemove={() => onChange(filters.filter((_, i) => i !== index))}
        />
      ))}
      <label className="filter-add">
        {addLabel}
        {/* Step 4b makes this scope a drop target too. The select stays
            regardless: drag is never the only path to anything. */}
        <select
          value=""
          onChange={(e) => add(e.target.value)}
          disabled={available.length === 0}
        >
          <option value="">Choose a field…</option>
          {available.map((field) => (
            <option key={refOf(field)} value={refOf(field)}>
              {refOf(field)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export default function FilterPane({
  view, fields, reportFilters, visualFilters, selectedVisualTitle,
  onChangeReport, onChangeVisual,
}: Props) {
  return (
    <section className="filter-pane">
      <h3>Filters</h3>
      <FilterScope
        heading="Filters on this report"
        emptyText="No filters on this report. Every visual shows all its data."
        addLabel="Add a filter on this report"
        filters={reportFilters}
        fields={fields}
        view={view}
        onChange={onChangeReport}
      />
      {visualFilters !== null && (
        <FilterScope
          heading={`Filters on "${selectedVisualTitle || "this visual"}"`}
          emptyText="No filters on this visual. It shows everything the report filters allow."
          addLabel="Add a filter on this visual"
          filters={visualFilters}
          fields={fields}
          view={view}
          onChange={onChangeVisual}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 4: Wire it into the builder**

In `frontend/src/reports/BuilderPage.tsx`:

Import `FilterPane` and `type Filter`. Add `filters: []` to the `visual` object built in `addVisual` (`BuilderPage.tsx:276-283`).

Render the pane after the Fields `<section>` inside `<aside className="builder-panes">`:

```tsx
              <FilterPane
                view={view}
                fields={[...dimensions, ...metrics]}
                reportFilters={definition.filters ?? []}
                visualFilters={selected ? (selected.filters ?? []) : null}
                selectedVisualTitle={selected ? visualTitle(selected) : null}
                onChangeReport={(filters) => setDefinition({ ...definition, filters })}
                onChangeVisual={(filters) => {
                  if (selected) replaceVisual({ ...selected, filters });
                }}
              />
```

Import `visualTitle` from `../query/renderers`.

- [ ] **Step 4b: Make each filter scope a drop target**

The spec asks for "drag a field onto the pane or click a field's filter affordance". The builder already runs a `DndContext` whose draggables carry `{ ref, kind }` (`BuilderPage.tsx:103`), so a scope only needs to become droppable and `onDragEnd` needs to recognise it.

Write the failing test first, in `FilterPane.test.tsx`:

```tsx
it("exposes each scope as a drop target", () => {
  wrap(<FilterPane {...props} visualFilters={[]} selectedVisualTitle="T" />);
  expect(screen.getByTestId("filter-drop-report")).toBeInTheDocument();
  expect(screen.getByTestId("filter-drop-visual")).toBeInTheDocument();
});
```

In `FilterScope`, take a `dropId: string` prop and wrap the scope:

```tsx
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  // ...
  <div
    className={isOver ? "filter-scope over" : "filter-scope"}
    ref={setNodeRef}
    data-testid={dropId.replace("filter:", "filter-drop-")}
  >
```

passing `dropId="filter:report"` and `dropId="filter:visual"` from `FilterPane`.

In `BuilderPage`'s `onDragEnd` (`BuilderPage.tsx:308`), handle the new targets **before** the existing `well:` branch, since that branch returns early for any id it does not recognise:

```tsx
    if (overId === "filter:report" || overId === "filter:visual") {
      if (!data) return;
      const scope = overId === "filter:report" ? definition.filters ?? [] : selected?.filters ?? [];
      // Already filtered at this scope: adding a second filter on the same
      // field would AND two conditions on one column, which is almost never
      // what dropping it again meant.
      if (scope.some((f) => f.field === data.ref)) return;
      const next = [...scope, { id: newFilterId(), field: data.ref, op: "is" as const, values: [] }];
      if (overId === "filter:report") setDefinition({ ...definition, filters: next });
      else if (selected) replaceVisual({ ...selected, filters: next });
      return;
    }
```

Add a matching builder test asserting a dropped dimension lands in the report scope, driving `onDragEnd` directly the way the existing well-drop tests in `BuilderPage.test.tsx` do rather than simulating pointer events.

Add the hover style alongside the other filter rules:

```css
.filter-scope.over { outline: 2px dashed var(--accent); outline-offset: 2px; }
```

- [ ] **Step 4c: Pass the report-level context down through the canvas**

```tsx
            <CanvasGrid
              visuals={definition.visuals}
              canvas={definition.canvas}
              view={view}
              reportFilters={definition.filters ?? []}
              hierarchies={definition.hierarchies ?? []}
              selectedId={selectedId}
              onSelect={selectVisual}
              onLayoutChange={onLayoutChange}
            />
```

In `CanvasGrid.tsx`, add `reportFilters: Filter[]` and `hierarchies: Hierarchy[]` to `Props` (defaulting both to `[]`) and forward them to each `VisualTile`. In `VisualTile.tsx`, accept them and pass them into `useVisualQuery`:

```tsx
  const { problems, ready, query } = useVisualQuery(view, visual, {
    reportFilters,
    hierarchies,
  });
```

- [ ] **Step 5: Add a builder-level test**

Append to `frontend/src/reports/BuilderPage.test.tsx`, matching the file's existing render helper and `/api/*` stubs:

```tsx
it("adds a report filter and includes it in the visual's query", async () => {
  renderBuilder();  // existing helper: report with one bar visual
  await screen.findByRole("heading", { name: /filters/i });

  await userEvent.selectOptions(
    screen.getByLabelText(/add a filter on this report/i), "CUSTOMERS.REGION",
  );
  await userEvent.click(await screen.findByRole("checkbox", { name: "EAST" }));

  await waitFor(() => {
    const call = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/api/query/semantic"))
      .at(-1);
    expect(JSON.parse(call![1].body).filters).toEqual([
      expect.objectContaining({ field: "CUSTOMERS.REGION", values: ["EAST"] }),
    ]);
  });
});

it("marks the report dirty when a filter is added", async () => {
  renderBuilder();
  await screen.findByRole("heading", { name: /filters/i });
  expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();

  await userEvent.selectOptions(
    screen.getByLabelText(/add a filter on this report/i), "CUSTOMERS.REGION",
  );
  expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();
});
```

- [ ] **Step 6: Add the styles**

In `frontend/src/index.css`, alongside the existing pane rules. Use the existing custom properties rather than new literal colours, and never a palette hex:

```css
.filter-pane { display: flex; flex-direction: column; gap: 12px; }
.filter-scope { display: flex; flex-direction: column; gap: 8px; }
.filter-scope h4 { margin: 0; font-size: 0.8125rem; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--text-muted); }
.filter-editor { border: 1px solid var(--border); border-radius: 6px; padding: 8px;
  display: flex; flex-direction: column; gap: 8px; }
.filter-editor-head { display: flex; justify-content: space-between; align-items: center;
  gap: 8px; }
.filter-field { font-weight: 600; overflow-wrap: anywhere; }
/* Bounded so a high-cardinality dimension cannot push the pane off-screen. */
.filter-values { max-height: 200px; overflow-y: auto; display: flex;
  flex-direction: column; gap: 2px; }
.filter-value { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.filter-range, .filter-relative { display: flex; gap: 8px; }
.filter-range label, .filter-relative label { flex: 1; }
.filter-add select { width: 100%; }
```

- [ ] **Step 7: Run the frontend suite**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/reports/FilterPane.tsx frontend/src/reports/FilterPane.test.tsx frontend/src/reports/BuilderPage.tsx frontend/src/reports/BuilderPage.test.tsx frontend/src/reports/CanvasGrid.tsx frontend/src/reports/VisualTile.tsx frontend/src/index.css
git commit -m "feat: Filters pane with report and visual scope"
```

---

## Task 11: Chart marks become clickable

Both drill-down and cross-filtering are "the user clicked a mark". `AutoChart` currently swallows every click, so this lands first, on its own, with keyboard equivalents — because a feature reachable only by clicking a chart is a feature screen-reader and keyboard users do not have.

**Files:**
- Modify: `frontend/src/query/AutoChart.tsx`
- Test: `frontend/src/query/AutoChart.test.tsx` (create)

**Interfaces:**
- Produces: `AutoChart` gains `onMarkClick?: (category: string) => void`; when supplied the chart container becomes focusable (`tabIndex={0}`) and `role="button"`

- [ ] **Step 1: Write the failing test**

ECharts does not render measurably in jsdom, so this asserts the wiring — that a handler is registered and that the container is reachable — rather than simulating a real canvas click.

```tsx
// frontend/src/query/AutoChart.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as echarts from "echarts";
import AutoChart from "./AutoChart";

const OPTION = {
  xAxis: { type: "category", data: ["EAST", "WEST"] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [1, 2] }],
};

describe("AutoChart mark clicks", () => {
  it("registers a click handler when onMarkClick is supplied", () => {
    const on = vi.fn();
    vi.spyOn(echarts, "init").mockReturnValue({
      setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on, off: vi.fn(),
    } as never);

    render(<AutoChart kind="bar" title="T" option={OPTION} onMarkClick={vi.fn()} />);
    expect(on).toHaveBeenCalledWith("click", expect.any(Function));
    vi.restoreAllMocks();
  });

  it("passes the clicked category name to the callback", () => {
    const onMarkClick = vi.fn();
    let handler: ((p: { name: string }) => void) | undefined;
    vi.spyOn(echarts, "init").mockReturnValue({
      setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), off: vi.fn(),
      on: (_e: string, fn: (p: { name: string }) => void) => { handler = fn; },
    } as never);

    render(<AutoChart kind="bar" title="T" option={OPTION} onMarkClick={onMarkClick} />);
    handler!({ name: "EAST" });
    expect(onMarkClick).toHaveBeenCalledWith("EAST");
    vi.restoreAllMocks();
  });

  it("is focusable and exposed as a button when interactive", () => {
    render(<AutoChart kind="bar" title="Revenue" option={OPTION} onMarkClick={vi.fn()} />);
    const chart = screen.getByRole("button", { name: /revenue/i });
    expect(chart).toHaveAttribute("tabindex", "0");
  });

  it("stays a plain image when it is not interactive", () => {
    render(<AutoChart kind="bar" title="Revenue" option={OPTION} />);
    expect(screen.getByRole("img", { name: /revenue/i })).not.toHaveAttribute("tabindex");
  });

  it("activates the first category on Enter, so the keyboard reaches drill-down", async () => {
    const onMarkClick = vi.fn();
    render(
      <AutoChart kind="bar" title="T" option={OPTION} onMarkClick={onMarkClick}
        categories={["EAST", "WEST"]} />,
    );
    const chart = screen.getByRole("button", { name: "T" });
    chart.focus();
    await userEvent.keyboard("{Enter}");
    expect(onMarkClick).toHaveBeenCalledWith("EAST");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/query/AutoChart.test.tsx`
Expected: FAIL — `onMarkClick` is not a prop, so no handler is registered and the container keeps `role="img"`.

- [ ] **Step 3: Implement**

```tsx
export default function AutoChart({
  kind, categories = [], series = [], title, option, onMarkClick,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Held in a ref so the chart effect below does not have to re-run (and
  // re-create the whole chart) every time the parent hands down a new
  // callback identity.
  const clickRef = useRef(onMarkClick);
  clickRef.current = onMarkClick;

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.setOption(option ?? buildChartOption(kind, categories, series));
    chart.on("click", (params: { name?: string }) => {
      if (params?.name) clickRef.current?.(params.name);
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
    // ... existing dependency comment unchanged ...
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, option ? [option, title] : [kind, categories, series]);

  const interactive = Boolean(onMarkClick);

  return (
    <div
      ref={ref}
      className="auto-chart"
      // A canvas/SVG chart is unreachable by keyboard on its own. Enter
      // activates the first category, which is enough to drill without a
      // mouse; the breadcrumb then handles going back up.
      role={interactive ? "button" : "img"}
      tabIndex={interactive ? 0 : undefined}
      aria-label={title}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === "Enter" && categories[0]) {
          e.preventDefault();
          clickRef.current?.(categories[0]);
        }
      }}
    />
  );
}
```

Add `onMarkClick?: (category: string) => void;` to `Props`, documented as *"When supplied, the chart becomes interactive: clicking a mark reports its category name. Drives drill-down and cross-filtering."*

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && npx vitest run src/query/AutoChart.test.tsx && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/query/AutoChart.tsx frontend/src/query/AutoChart.test.tsx
git commit -m "feat: chart marks report clicks, by mouse and by keyboard"
```

---

## Task 12: Hierarchies and drill-down

**Files:**
- Create: `frontend/src/reports/HierarchyPane.tsx`, `frontend/src/reports/HierarchyPane.test.tsx`
- Modify: `frontend/src/reports/VisualTile.tsx`, `frontend/src/reports/CanvasGrid.tsx`, `frontend/src/reports/BuilderPage.tsx`, `frontend/src/index.css`
- Test: `frontend/src/reports/VisualTile.test.tsx`

**Interfaces:**
- Consumes: `resolveWells`, `currentLevel`, `canDrillDown`, `hierarchyIdOf`, `hierarchyById`, `DrillState`
- Produces: `<HierarchyPane hierarchies dimensions onChange />`; `VisualTile` gains `drill`, `onDrill: (next: DrillState | undefined) => void`

- [ ] **Step 1: Write the failing tile test**

Append to `frontend/src/reports/VisualTile.test.tsx`, following the file's existing render helper and stubs:

```tsx
const GEO = {
  id: "h1", name: "Geography",
  levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"],
};

function hierarchyVisual() {
  return {
    id: "v1", type: "bar", title: "By geography",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["hierarchy:h1"], legend: [], values: ["ORDERS.TOTAL"] },
    options: {}, filters: [],
  };
}

it("shows the top level and no breadcrumb when undrilled", async () => {
  renderTile(hierarchyVisual(), { hierarchies: [GEO] });
  await screen.findByRole("img", { name: /by geography/i });
  expect(screen.queryByRole("navigation", { name: /drill path/i })).not.toBeInTheDocument();
  expect(screen.getByText(/CUSTOMERS.COUNTRY/)).toBeInTheDocument();
});

it("drilling a mark advances the level and records the path", async () => {
  const onDrill = vi.fn();
  renderTile(hierarchyVisual(), { hierarchies: [GEO], onDrill });
  await userEvent.click(await screen.findByRole("button", { name: /by geography/i }));
  expect(onDrill).toHaveBeenCalledWith({
    hierarchyId: "h1",
    path: [{ field: "CUSTOMERS.COUNTRY", value: "EAST" }],
  });
});

it("shows a breadcrumb and an up control once drilled", async () => {
  renderTile(hierarchyVisual(), {
    hierarchies: [GEO],
    drill: { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
  });
  const nav = await screen.findByRole("navigation", { name: /drill path/i });
  expect(nav).toHaveTextContent("US");
  expect(screen.getByRole("button", { name: /drill up/i })).toBeInTheDocument();
});

it("drill up pops one level", async () => {
  const onDrill = vi.fn();
  renderTile(hierarchyVisual(), {
    hierarchies: [GEO], onDrill,
    drill: { hierarchyId: "h1", path: [
      { field: "CUSTOMERS.COUNTRY", value: "US" },
      { field: "CUSTOMERS.STATE", value: "CA" },
    ] },
  });
  await userEvent.click(await screen.findByRole("button", { name: /drill up/i }));
  expect(onDrill).toHaveBeenCalledWith({
    hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }],
  });
});

it("drilling up from the top level clears the drill state entirely", async () => {
  const onDrill = vi.fn();
  renderTile(hierarchyVisual(), {
    hierarchies: [GEO], onDrill,
    drill: { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
  });
  await userEvent.click(await screen.findByRole("button", { name: /drill up/i }));
  expect(onDrill).toHaveBeenCalledWith(undefined);
});

it("stops drilling at the last level", async () => {
  const onDrill = vi.fn();
  renderTile(hierarchyVisual(), {
    hierarchies: [GEO], onDrill,
    drill: { hierarchyId: "h1", path: [
      { field: "CUSTOMERS.COUNTRY", value: "US" },
      { field: "CUSTOMERS.STATE", value: "CA" },
    ] },
  });
  const chart = await screen.findByRole("img", { name: /by geography/i });
  expect(chart).not.toHaveAttribute("tabindex");
  expect(onDrill).not.toHaveBeenCalled();
});

it("Backspace drills up", async () => {
  const onDrill = vi.fn();
  renderTile(hierarchyVisual(), {
    hierarchies: [GEO], onDrill,
    drill: { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
  });
  (await screen.findByRole("button", { name: /by geography/i })).focus();
  await userEvent.keyboard("{Backspace}");
  expect(onDrill).toHaveBeenCalledWith(undefined);
});

it("reports a level that has vanished from the view without blanking the tile", async () => {
  renderTile(hierarchyVisual(), { hierarchies: [] });
  expect(await screen.findByText(/hierarchy this visual uses/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/reports/VisualTile.test.tsx`
Expected: FAIL — `VisualTile` takes no `drill`/`onDrill`/`hierarchies`.

- [ ] **Step 3: Implement `VisualTile`**

Add to `Props`:

```tsx
  reportFilters?: Filter[];
  hierarchies?: Hierarchy[];
  drill?: DrillState;
  onDrill?: (next: DrillState | undefined) => void;
  crossFilter?: CrossFilter | null;
  onCrossFilter?: (next: CrossFilter | null) => void;
```

Inside the component, before the body branches:

```tsx
  const axisRef = (visual.wells.axis ?? [])[0] ?? "";
  const hierarchyId = hierarchyIdOf(axisRef);
  const hierarchy = hierarchyId ? hierarchyById(hierarchies, hierarchyId) : undefined;
  const depth = drill?.hierarchyId === hierarchyId ? drill.path.length : 0;
  const drillable = Boolean(hierarchy && onDrill && canDrillDown(hierarchy, depth));

  const { problems, ready, query } = useVisualQuery(view, visual, {
    reportFilters, hierarchies, drill, crossFilter,
  });

  const onMark = (category: string) => {
    if (drillable && hierarchy) {
      onDrill?.({
        hierarchyId: hierarchy.id,
        path: [...(drill?.path ?? []), { field: currentLevel(hierarchy, depth), value: category }],
      });
      return;
    }
    // Not drillable: the click is a cross-filter selection instead. Clicking
    // the same mark again clears it, so a selection is always reversible
    // without hunting for a Clear control.
    const field = (visual.wells.axis ?? visual.wells.legend ?? [])[0];
    if (!field || !onCrossFilter) return;
    const same =
      crossFilter?.sourceVisualId === visual.id &&
      crossFilter.field === field &&
      crossFilter.value === category;
    onCrossFilter(same ? null : { sourceVisualId: visual.id, field, value: category });
  };

  const drillUp = () => {
    if (!drill) return;
    const path = drill.path.slice(0, -1);
    // Dropping to an empty path clears the state rather than keeping an
    // empty one, so "am I drilled?" is a single null check everywhere.
    onDrill?.(path.length ? { ...drill, path } : undefined);
  };
```

Guard the missing-hierarchy case before the normal body branches:

```tsx
  if (hierarchyId && !hierarchy) {
    body = (
      <p role="alert" className="tile-error">
        The hierarchy this visual uses is no longer defined on this report. Edit
        its Axis well to pick a field or hierarchy.
      </p>
    );
  }
```

Pass `onMarkClick` to the chart only when the click means something:

```tsx
      body = (
        <AutoChartAdapter
          kind="bar" title={title} option={option}
          categories={query.data.rows.map((r) => String(r[0]))}
          onMarkClick={drillable || onCrossFilter ? onMark : undefined}
        />
      );
```

Render the breadcrumb in the tile header when drilled:

```tsx
      <header className="tile-head">
        <h3>{title || "Untitled visual"}</h3>
        {drill && drill.path.length > 0 && (
          <nav className="drill-path" aria-label="Drill path">
            <button type="button" className="link" onClick={drillUp}>
              Drill up
            </button>
            <span>{drill.path.map((s) => s.value).join(" › ")}</span>
          </nav>
        )}
      </header>
```

and add the keyboard equivalent on the tile section:

```tsx
      onKeyDown={(e) => {
        if (e.key === "Backspace" && drill) {
          e.preventDefault();
          drillUp();
        }
      }}
```

- [ ] **Step 4: Hold drill state in `BuilderPage`**

Ephemeral, keyed by visual id, and reset whenever the report identity changes — add `setDrill({})` and `setCrossFilter(null)` to the existing `[reportId]` reset effect at `BuilderPage.tsx:179`.

```tsx
  // Ephemeral by design: never written to the definition, so a saved report
  // always opens at the top level and can never point at a value that has
  // since disappeared from the view.
  const [drill, setDrill] = useState<Record<string, DrillState>>({});
  const [crossFilter, setCrossFilter] = useState<CrossFilter | null>(null);
```

Pass `drill`, `onDrill`, `crossFilter`, `onCrossFilter` through `CanvasGrid` to each tile, with `CanvasGrid` selecting `drill[visual.id]` per tile.

- [ ] **Step 5: Write the failing hierarchy-pane test**

```tsx
// frontend/src/reports/HierarchyPane.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldInfo, Hierarchy } from "../api/types";
import HierarchyPane from "./HierarchyPane";

const DIMENSIONS: FieldInfo[] = [
  { table: "CUSTOMERS", name: "COUNTRY", dataType: "VARCHAR" },
  { table: "CUSTOMERS", name: "STATE", dataType: "VARCHAR" },
  { table: "CUSTOMERS", name: "CITY", dataType: "VARCHAR" },
];

const GEO: Hierarchy = {
  id: "h1", name: "Geography", levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE"],
};

describe("HierarchyPane", () => {
  it("says there are none yet", () => {
    render(<HierarchyPane hierarchies={[]} dimensions={DIMENSIONS} onChange={() => {}} />);
    expect(screen.getByText(/no hierarchies/i)).toBeInTheDocument();
  });

  it("creates one", async () => {
    const onChange = vi.fn();
    render(<HierarchyPane hierarchies={[]} dimensions={DIMENSIONS} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /new hierarchy/i }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "New hierarchy", levels: [] }),
    ]);
  });

  it("appends a level", async () => {
    const onChange = vi.fn();
    render(<HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={onChange} />);
    await userEvent.selectOptions(
      screen.getByLabelText(/add a level to Geography/i), "CUSTOMERS.CITY",
    );
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"],
      }),
    ]);
  });

  it("does not offer a dimension the hierarchy already uses", () => {
    render(<HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={() => {}} />);
    const select = screen.getByLabelText(/add a level to Geography/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).not.toContain("CUSTOMERS.COUNTRY");
  });

  it("warns while a hierarchy has fewer than two levels", () => {
    render(
      <HierarchyPane
        hierarchies={[{ id: "h1", name: "Geo", levels: ["CUSTOMERS.COUNTRY"] }]}
        dimensions={DIMENSIONS}
        onChange={() => {}}
      />,
    );
    // Saving would fail server-side; saying so here beats a 400 later.
    expect(screen.getByText(/needs at least two levels/i)).toBeInTheDocument();
  });

  it("removes a level and a whole hierarchy", async () => {
    const onChange = vi.fn();
    render(<HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /remove CUSTOMERS.STATE/i }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ levels: ["CUSTOMERS.COUNTRY"] }),
    ]);

    onChange.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /delete Geography/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 6: Write `HierarchyPane`**

```tsx
// frontend/src/reports/HierarchyPane.tsx
import type { FieldInfo, Hierarchy } from "../api/types";

interface Props {
  hierarchies: Hierarchy[];
  dimensions: FieldInfo[];
  onChange: (next: Hierarchy[]) => void;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

export default function HierarchyPane({ hierarchies, dimensions, onChange }: Props) {
  const replace = (index: number, next: Hierarchy) =>
    onChange(hierarchies.map((h, i) => (i === index ? next : h)));

  return (
    <section className="hierarchy-pane">
      <h3>Hierarchies</h3>
      {hierarchies.length === 0 && (
        <p className="tile-hint">
          No hierarchies yet. Build one to let a visual drill from a broad level
          to a narrow one.
        </p>
      )}
      {hierarchies.map((hierarchy, index) => {
        const used = new Set(hierarchy.levels);
        const available = dimensions.filter((d) => !used.has(refOf(d)));
        return (
          <div key={hierarchy.id} className="hierarchy">
            <div className="hierarchy-head">
              <input
                aria-label={`Hierarchy name for ${hierarchy.name}`}
                value={hierarchy.name}
                onChange={(e) => replace(index, { ...hierarchy, name: e.target.value })}
              />
              <button
                type="button" className="link"
                onClick={() => onChange(hierarchies.filter((_, i) => i !== index))}
              >
                Delete {hierarchy.name}
              </button>
            </div>
            <ol className="hierarchy-levels">
              {hierarchy.levels.map((level) => (
                <li key={level}>
                  <span>{level}</span>
                  <button
                    type="button" className="link"
                    onClick={() =>
                      replace(index, {
                        ...hierarchy,
                        levels: hierarchy.levels.filter((l) => l !== level),
                      })
                    }
                  >
                    Remove {level}
                  </button>
                </li>
              ))}
            </ol>
            {hierarchy.levels.length < 2 && (
              // The server rejects this on save; saying so here turns a 400
              // into an inline hint.
              <p className="tile-hint">
                A hierarchy needs at least two levels — one level is just a field.
              </p>
            )}
            <label>
              Add a level to {hierarchy.name}
              <select
                value=""
                disabled={available.length === 0}
                onChange={(e) =>
                  e.target.value &&
                  replace(index, {
                    ...hierarchy,
                    levels: [...hierarchy.levels, e.target.value],
                  })
                }
              >
                <option value="">Choose a dimension…</option>
                {available.map((d) => (
                  <option key={refOf(d)} value={refOf(d)}>{refOf(d)}</option>
                ))}
              </select>
            </label>
          </div>
        );
      })}
      <button
        type="button" className="secondary"
        onClick={() =>
          onChange([
            ...hierarchies,
            { id: `h${crypto.randomUUID().slice(0, 8)}`, name: "New hierarchy", levels: [] },
          ])
        }
      >
        New hierarchy
      </button>
    </section>
  );
}
```

Render it in `BuilderPage`'s right-hand stack beneath `FilterPane`, wired to `definition.hierarchies`. In `VisualWells`, list each declared hierarchy alongside the dimension fields so a user can place `hierarchy:<id>` in a dimension well.

- [ ] **Step 7: Styles**

```css
.drill-path { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem;
  color: var(--text-muted); }
.hierarchy { border: 1px solid var(--border); border-radius: 6px; padding: 8px;
  display: flex; flex-direction: column; gap: 8px; }
.hierarchy-head { display: flex; gap: 8px; align-items: center; }
.hierarchy-levels { margin: 0; padding-left: 20px; display: flex;
  flex-direction: column; gap: 4px; }
.hierarchy-levels li { display: flex; justify-content: space-between; gap: 8px;
  min-height: 24px; align-items: center; }
```

- [ ] **Step 8: Run the frontend suite**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add frontend/src/reports/ frontend/src/index.css
git commit -m "feat: hierarchies with click and keyboard drill-down"
```

---

## Task 13: Cross-filtering

The click plumbing landed in Task 11 and the composition rule in Task 7; this task makes the state visible and clearable.

**Files:**
- Modify: `frontend/src/reports/BuilderPage.tsx`, `frontend/src/index.css`
- Test: `frontend/src/reports/BuilderPage.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it("clicking a mark cross-filters the other visuals but not its own", async () => {
  renderBuilder({ visuals: [barVisual("v1"), barVisual("v2")] });
  const charts = await screen.findAllByRole("button", { name: /revenue/i });
  await userEvent.click(charts[0]);

  await waitFor(() => {
    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/api/query/semantic"))
      .map(([, init]) => JSON.parse(init.body));
    // The source visual keeps its unfiltered query; its sibling gains the
    // selection.
    expect(bodies.some((b) => b.filters.length === 0)).toBe(true);
    expect(bodies.some((b) => b.filters.some((f) => f.values[0] === "EAST"))).toBe(true);
  });
});

it("shows a labelled chip while a selection is active, and clears it", async () => {
  renderBuilder({ visuals: [barVisual("v1"), barVisual("v2")] });
  const charts = await screen.findAllByRole("button", { name: /revenue/i });
  await userEvent.click(charts[0]);

  const chip = await screen.findByRole("status");
  expect(chip).toHaveTextContent(/filtered by/i);
  expect(chip).toHaveTextContent("EAST");

  await userEvent.click(screen.getByRole("button", { name: /clear cross-filter/i }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("does not persist the selection into the saved definition", async () => {
  renderBuilder({ visuals: [barVisual("v1"), barVisual("v2")] });
  const charts = await screen.findAllByRole("button", { name: /revenue/i });
  await userEvent.click(charts[0]);
  await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));

  await waitFor(() => {
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    const saved = JSON.parse(put![1].body).definition;
    expect(JSON.stringify(saved)).not.toContain("sourceVisualId");
    expect(saved.filters).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/reports/BuilderPage.test.tsx`
Expected: FAIL — no chip is rendered and no clear control exists.

- [ ] **Step 3: Implement the chip**

In `BuilderPage.tsx`, above `<div className="builder-body">`:

```tsx
          {crossFilter && (
            // role="status" rather than a bare div: a filter applied by
            // clicking somewhere else must be announced, not just drawn.
            <p className="cross-filter-chip" role="status">
              Filtered by {crossFilter.field} = {crossFilter.value}
              <button type="button" className="link" onClick={() => setCrossFilter(null)}>
                Clear cross-filter
              </button>
            </p>
          )}
```

```css
.cross-filter-chip { display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px;
  /* Deliberately NOT a series colour: chrome is never painted from the
     chart palette, or a chip reads as a data category. */
  background: var(--surface-2); width: fit-content; margin: 0 0 8px; }
```

- [ ] **Step 4: Run the frontend suite**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/reports/BuilderPage.tsx frontend/src/reports/BuilderPage.test.tsx frontend/src/index.css
git commit -m "feat: cross-filtering with a visible, clearable selection"
```

---

## Task 14: Integration tests, real-browser pass, and docs

The 2a review established that a network-stubbed pass proves component wiring and nothing about whether the real API accepts what the frontend sends. This task closes that gap for 2b specifically.

**Files:**
- Modify: `backend/tests/integration/test_snowflake_it.py`, `README.md`
- Create: `docs/superpowers/manual-passes/2026-08-15-filters-drilldown.md`

- [ ] **Step 1: Add the integration tests**

```python
def test_filtered_query_against_a_real_view(conn, view_ref):
    """A filtered query must return a strict subset, with the value bound."""
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    dim = detail["dimensions"][0]
    ref = f"{dim['table']}.{dim['name']}"
    mets = [f"{m['table']}.{m['name']}" for m in detail["metrics"][:1]]

    unfiltered = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [ref], "metrics": mets, "limit": 50}
    )
    sql, params, limit = build_semantic_sql(detail, unfiltered, max_rows=10000)
    baseline = run_query(conn, sql, max_rows=limit, params=params)
    assert baseline.rows, "view returned no rows; cannot exercise a filter"

    value = str(baseline.rows[0][0])
    filtered = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [ref], "metrics": mets, "limit": 50,
         "filters": [{"id": "f1", "field": ref, "op": "is", "values": [value]}]}
    )
    sql, params, limit = build_semantic_sql(detail, filtered, max_rows=10000)
    assert value not in sql, "filter value leaked into SQL text"
    assert params == [value]
    result = run_query(conn, sql, max_rows=limit, params=params)
    assert len(result.rows) == 1
    assert str(result.rows[0][0]) == value


def test_a_hostile_filter_value_is_data_not_sql(conn, view_ref):
    """The injection round-trip, end to end against Snowflake: the statement
    must execute and simply match nothing."""
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    dim = detail["dimensions"][0]
    ref = f"{dim['table']}.{dim['name']}"
    req = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [ref], "limit": 10,
         "filters": [{"id": "f1", "field": ref, "op": "is",
                      "values": ["' OR 1=1 --"]}]}
    )
    sql, params, limit = build_semantic_sql(detail, req, max_rows=10000)
    result = run_query(conn, sql, max_rows=limit, params=params)
    assert result.rows == [], "a bound hostile value matched rows -- it was not bound"


def test_records_whether_the_account_exposes_hierarchies(conn, view_ref):
    """Settles the model-first question with evidence rather than assumption.

    Never fails: it exists to record what this account actually returns.
    """
    db, schema, name = view_ref
    cur = conn.cursor()
    try:
        cur.execute(f'DESCRIBE SEMANTIC VIEW "{db}"."{schema}"."{name}"')
        kinds = sorted({str(row[0]).upper() for row in cur.fetchall()})
        print(f"\n[hierarchy probe] object kinds in DESCRIBE: {kinds}")
        print(f"[hierarchy probe] hierarchy-shaped: {[k for k in kinds if 'HIER' in k]}")
    finally:
        cur.close()
```

- [ ] **Step 2: Run them**

Run: `cd backend && python -m pytest tests/integration -v -s -m integration`
Expected: PASS. If they skip, the credentials are missing — say so in the report rather than claiming a pass.

- [ ] **Step 3: Real-browser pass, unstubbed**

Run the backend and frontend for real, log in with actual Snowflake credentials, and drive the browser against the **live API — no `page.route` stubs**. This is the pass that would have caught the 2a "New report" bug. Record each step's result in `docs/superpowers/manual-passes/2026-08-15-filters-drilldown.md`:

1. Open a report, add a report-scope filter, pick two values → every tile requeries and narrows.
2. Add a visual-scope filter on one tile → only that tile changes.
3. Filter a **KPI card** by a dimension it does not display → the number changes and no error appears. *(This is the spike's Q3 proven end-to-end in the product.)*
4. Define a two-level hierarchy, place it on a bar's Axis, click a bar → axis advances, breadcrumb appears.
5. Drill up via the control, then again via Backspace → returns to the top level.
6. Click a mark on a non-hierarchy visual → siblings filter, the source does not, the chip appears.
7. Clear the chip → everything returns.
8. Save, reload → filters and hierarchies persist; drill position and cross-filter do **not**.
9. Export the report, import it → filters and hierarchies survive the round trip.
10. Load a report saved **before** this branch → it still opens (the v1 migration).
11. Resize to 1440 / 1280 / 1024 / 768 / 390px → the Filters pane stays usable and nothing overflows.
12. Tab to a chart and press Enter → it drills without a mouse.

- [ ] **Step 4: Update the README**

Document the filter model, the two scopes, the `values` endpoint, and that drill position and cross-filter selection are deliberately not persisted. State plainly that filter values are bound parameters and never SQL text, and point at `app/semantic/predicates.py` as the single place that rule is enforced.

- [ ] **Step 5: Full suite, both sides**

Run: `cd backend && python -m pytest -v` then `cd frontend && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/tests/integration/ README.md docs/superpowers/manual-passes/
git commit -m "test: filter and drill integration coverage, unstubbed manual pass, docs"
```

---

## Done When

- The spike's findings file records the real Snowflake syntax, and the implementation matches it.
- A filter value containing `' OR 1=1 --` round-trips as data — asserted in a unit test against the generated SQL, and end-to-end against the real account.
- A KPI card can be filtered by a dimension it does not display.
- A v1 report saved before this branch still opens.
- Drill position and cross-filter selection survive no reload, and appear nowhere in an exported document.
- The layout holds at all five breakpoints, and every drill action has a keyboard equivalent.
