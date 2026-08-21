# Visual model designer — design

Status: Proposed (design only; nothing built)
Date: 2026-08-21
Builds on: [composite models v1](2026-08-20-composite-semantic-models-v1-runtime-drill-across.md)

A canvas for authoring a composite model, in the visual language the
report model diagram already uses — but editable. Member views are
coloured backdrops holding their own tables; the conformed dimensions
that make the model answerable are edges you draw between columns.

---

## 1. Why a canvas at all

The form works and is staying (§7). What it cannot do is show you the
*shape* of what you are building: which views are in play, which tables
each brings, where they already touch, and — the question the form makes
hardest — **which columns are candidates for meaning the same thing**.

A mapping is a statement about two columns. A form asks you to type both
from memory; a canvas lets you point at them. That is the whole argument,
and it is the same argument PowerBI's model view makes.

## 2. What is on the canvas

```
┌─ sales ─────────────────────────┐   ┌─ support ───────────────────┐
│ ┌────────┐      ┌──────────┐    │   │ ┌────────┐    ┌──────────┐  │
│ │ORDERS  │─────▶│CUSTOMER  │    │   │ │TICKETS │───▶│CLIENT    │  │
│ │ REVENUE│      │ CUSTOMER_ID●───┼━━━┿━━━━━━━━━━━━━━▶│●CLIENT_ID│  │
│ │ AMOUNT │      │ NAME     │    │   │ │ COUNT  │    │ NAME     │  │
│ └────────┘      └──────────┘    │   │ └────────┘    └──────────┘  │
└─────────────────────────────────┘   └─────────────────────────────┘
   ───▶  the view's own join (read-only)
   ━━━▶  a conformed dimension (yours; drag to make, click to name)
```

**Three kinds of thing, and the difference between them is the point:**

| | What it is | Editable |
|---|---|---|
| **View backdrop** | One member, in its own colour | Rename alias, remove view |
| **Table card** | A table inside that view | No — Snowflake's |
| **Internal edge** | A relationship the view declares | **No.** Drawn muted with a lock on hover, so it is clear *why* it does not respond rather than seeming broken |
| **Conformed edge** | "These columns mean the same thing" | **Yes** — draw, name, extend to a third view, delete |

### Colour

Each member gets a colour from a fixed palette, assigned by its position
in the model so it is stable across renders and reloads. The backdrop is
that colour at low opacity; the table cards carry it as a header stripe;
a conformed edge is drawn in a neutral ink so it never reads as belonging
to one side. Past the palette's length colours repeat — with eight
members capped, they do not.

Colour is never the only signal: every backdrop carries the alias as a
label, because a colour-blind reader gets nothing from the fill.

## 3. Collapsed by default, and what expanding shows

Eight views of eight tables is sixty-four cards. So a backdrop starts
**collapsed**: the view's name, its table count, and a row per column
that already takes part in a conformed dimension — nothing else.

That last part is what makes collapsed useful rather than merely small:
**a conformed edge always has somewhere to land.** Collapsed, it anchors
to the column's row on the backdrop itself.

Expanding lays out the view's tables inside the backdrop and **re-anchors
every edge to the real column handle on the real card** — the view's own
internal relationships appear at the same moment, because seeing how a
view is joined internally is most of why you would expand it.

Both states show relationships. The difference is precision: collapsed
says *these two views meet on Customer*; expanded says *they meet on
`CUSTOMER.CUSTOMER_ID` and `CLIENT.CLIENT_ID`, and inside sales that
column is reached from ORDERS*.

Expansion is per view, remembered per model in localStorage — the same
reasoning as the resizable pane: it is a fact about how somebody reads,
not about the model.

## 4. Making a mapping

**By dragging.** Pull from a column handle in one view to a column handle
in another. On drop:

- **Neither column is mapped** → a new shared dimension, named from the
  column (`CUSTOMER_ID` → "Customer") and immediately editable inline.
- **One end is already in a shared dimension** → the other end is added
  as a binding to it. This is how a model reaches three or more views:
  drag `web.VISITS.CUSTOMER_ID` onto the existing Customer edge and it
  becomes a three-way conformed dimension, not a second pairwise one.
- **Both are in *different* shared dimensions** → refused, with a
  sentence: merging two named concepts is a decision, not a drag.

**A drag within one view is refused** and says why: a view's own joins
are Snowflake's, and a conformed dimension relates *different* views.

**By auto-detect.** The same rules the form uses today
(`models/matching.ts`), rendered as **ghost edges** — dashed, in the
palette's muted ink, with the evidence on hover ("same key column in 2
views"). A ghost becomes real on click. A **Detect relationships** button
accepts every ghost at once; **Dismiss** removes one and remembers it for
the session, so re-detecting does not re-offer what you just rejected.

Ghosts appear when you ask, not automatically — a canvas that fills with
dashed lines the moment you add a view teaches people to ignore them.
This is the one place the design departs from PowerBI, which autodetects
on add; the reason is that our matcher is deliberately conservative and a
model with fifteen same-named columns would bury the two that matter.

## 5. What the canvas will not do

Stated because the alternative is looking for them:

- **No cardinality editor.** A conformed dimension is always key-to-key
  equality. The crow's-foot is drawn from the members' own declarations;
  there is nothing to choose, and offering a dropdown would imply
  otherwise.
- **No cross-filter direction per relationship.** It is a model-level
  setting (`semi`/`local`), because the same question must not answer two
  ways depending on which edge somebody clicked.
- **No new tables, columns or joins inside a view.** Those are the
  warehouse's.

## 6. Architecture

Four modules, each with one job, mirroring how `model/` is already split:

| Module | Job |
|---|---|
| `designer/layout.ts` | Definition + member describes → React Flow nodes and edges. Pure. Dagre lays out backdrops; each expanded backdrop lays out its own tables. |
| `designer/palette.ts` | Alias → colour, stable by position. Pure. |
| `designer/edits.ts` | The four gestures (§4) as pure functions on the definition: `relate`, `extend`, `rename`, `unrelate`. Every one takes a definition and returns a definition. |
| `designer/ModelDesigner.tsx` | The canvas: React Flow, drag handling, the ghost layer, the toolbar. |

**Reuse, not duplication.** `TableNode`, the crow's-foot markers, the
handle-id convention and the dagre helpers all come from `model/`. The
new node type is the backdrop (React Flow group node, children via
`parentId` + `extent: "parent"`); the new edge type is the conformed one.
Where `model/graph.ts` has logic worth sharing it moves up rather than
being copied — the alternative is two ER diagrams that drift.

**The definition is the single source of truth.** The canvas never holds
model state of its own: every gesture produces a new `CompositeDefinition`
and hands it to `ModelPage`, exactly as `SharedDimensions` does now. That
is what lets both tabs edit the same draft (§7) without a sync problem —
there is nothing to sync.

**Data.** One request: the composite describe already returns each
member's fields and, since the greying work, `memberGraphs` — the tables
and relationships the canvas needs. No new endpoint.

## 7. Tabs, and parity with the form

`ModelPage` gains **Design | Fields**. Design is the default; Fields is
the current form, unchanged.

Both edit the same draft object, so a mapping made by dragging appears in
the form and vice versa. Save is shared and lives in the header.

The form keeps three things that have no canvas gesture, and is where the
Design tab links to when you reach for them: **derived metrics**, the
**join type** and **cross-filter** settings, and **precise entry** —
typing an exact column beats hunting for it, and is the only way in on a
narrow screen where the canvas is not shown at all.

## 8. Testing

- `layout.ts`, `palette.ts`, `edits.ts` are pure and get exhaustive unit
  tests — the same treatment `graph.ts` and `relatedness.ts` already have.
- `edits.ts` carries the rules that would otherwise only exist in a drag
  handler: relate/extend/refuse-merge/refuse-within-a-view, each a test.
- The canvas gets interaction tests in the shape of `ModelInteraction.test.tsx`:
  expand a backdrop and assert the internal edges appear; drop a column on
  another and assert the definition that comes out.
- One test asserts a definition survives a round trip through the canvas
  unchanged — no gesture, no edit — because a designer that quietly
  reorders or drops a binding on open is worse than no designer.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Sixty-four cards is unreadable | Collapsed by default; expansion is per view and remembered |
| Two editors disagree | There is one draft; both tabs are views onto it |
| React Flow group nodes with dagre-inside-dagre misbehave | Layout is pure and unit-tested against fixtures before any canvas exists |
| Ghost edges become noise | Opt-in, dismissible, and the matcher stays conservative |
| The designer drifts from `model/` | Shared code moves up into one place rather than being copied down |

## 10. Delivery

1. **Palette + layout, pure.** Nodes, backdrops, both edge kinds, both
   collapse states. Unit-tested with no canvas.
2. **The canvas, read-only.** Render it in a Design tab. At this point it
   is the report diagram with backdrops and colour — already useful.
3. **Edits.** `edits.ts` and the drag gestures; inline naming; delete.
4. **Auto-detect.** Ghost layer over the existing matcher, Detect and
   Dismiss.
5. **Polish.** Expansion memory, the locked-edge affordance, narrow-screen
   fallback to Fields, docs.

Each step ships something usable, and step 2 is worth having even if the
rest waits.
