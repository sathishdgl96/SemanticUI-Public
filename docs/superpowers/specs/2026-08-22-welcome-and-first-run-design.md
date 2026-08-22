# Welcome and first run — design

Date: 2026-08-22
Status: approved in conversation, ready for planning

## The problem

Nothing in the product explains its shape. A person signing in for the first
time sees a nav rail, a home page, and no account of how the parts relate:
that a semantic view is where everything starts, that an explore becomes a
report, that a report's visuals pin onto a dashboard, that any of it can leave
through Excel.

The empty states are not the gap. They are already good, and this design does
not touch them:

- `explorer/ExplorerPage.tsx` — "Pick a field first — a report starts from
  something to show."
- `workspaces/WorkspacePage.tsx` — "Nothing here yet. Create a report or a
  dashboard.", with a comment distinguishing a dead end from an undoable
  filter.
- `home/HomePage.tsx` — "No dashboards yet. Create one, then pin visuals to it
  by right-clicking them on any report in its workspace."

Each teaches the *next click*. None teaches the *arc*, so a newcomer learns
the product one dead end at a time. Three things are actually missing:

1. **Nobody explains the arc.**
2. **First run points the wrong way.** Home tells a brand-new user to create a
   dashboard. That is right for month two and wrong for minute one — their
   first step is finding a semantic view and exploring it.
3. **Orientation cannot be re-found.** There is no help entry point anywhere
   in the shell, so anything shown once is gone for good.

## What already exists

- `users` already carries per-user preferences — `last_role`,
  `last_warehouse`, `home_dashboard_id` — so a first-run flag has an obvious
  home and needs no new table.
- Home already answers in one request. Its docstring: "Both halves arrive in
  one request. The page has nothing to show without each of them, and two
  round trips would only stagger the arrival."
- `session/ProfileMenu.tsx` is mounted in the shell and is where per-user
  entries already live.
- There is **no dialog primitive**. `frontend/src/ui/` has `ContextMenu`,
  `CloseButton`, `Icon`, `PaneResizer`; every dialog in the product is
  ad-hoc (`ExportPanel`, `ImportPanel`, `PinToDashboard`,
  `WorkspacesFlyout`).

## Scope

In:

- A welcome dialog, shown once per user on the first authenticated load.
- A shared `Dialog` primitive, because one does not exist.
- A "Getting started" entry in the profile menu that reopens it.
- Content that adapts to whether the user can already see anything.
- Home's first-run ordering: lead with exploring a model when the user has
  nothing.

Out, deliberately:

- Spotlight overlays, anchor contracts on other components, route-stepping
  tours. See "Why not a spotlight tour".
- Rewriting the empty states. They are already right.
- Migrating the existing ad-hoc panels onto the new `Dialog`. They can adopt
  it later; doing it here is unrelated scope.

## Shape: interrupt once, then be quiet

A dismissible card on Home would be quieter and cheaper — no focus trap, no
dialog primitive — and it would match the product's habit of keeping chrome
neutral. It is also easy to never notice, which is exactly wrong for the first
ninety seconds.

So: **one deliberate interruption at minute zero, then silence.** A dialog on
the first authenticated load, never shown again unprompted, with a permanent
way back. People expect one welcome moment and resent a second.

### Why not a spotlight tour

A step-through overlay that dims the app and highlights real elements is what
most people picture. It was rejected because it requires every component
hosting a step to expose a stable anchor — a cross-cutting contract across the
shell, the explorer and the report pages — plus route coordination, resize
handling and focus management, for a mechanism most users dismiss on step one.
The arc it would narrate fits in a paragraph, and a paragraph does not need to
take over the screen.

## The adaptive branch

Two paths, chosen by whether the user can already see anything:

- **Nothing readable** — no workspace membership, or membership with no items.
  "Start by exploring a model", then the arc: explore, save, turn it into a
  report, pin its visuals to a dashboard, take it to Excel.
- **Already in a populated workspace.** "Your team already has reports here."
  How to open one, filter it, and get it into Excel — and, only for an editor
  or admin, how to build their own. Telling a viewer to create a report is
  advice they cannot act on, and advice you cannot act on teaches people to
  stop reading.

**The branch is computed server-side** and rides along on Home's existing
payload as a `welcome` block. The client never asks "am I new?", and this
costs no extra round trip — the constant-query property Home already holds.

## Storage

One column on `users`:

| Column | Notes |
|---|---|
| `welcomed_at` | nullable timestamp; NULL means never shown |

Dismissal sets it. Reopening from the profile menu does not clear it, so a
second sign-in is never interrupted because somebody went looking for help.

The flag is per user rather than per session or per browser: a person who has
been oriented has been oriented, whichever machine they next sign in from.

## Where it lives

- `app/home/` — the `welcome` block added to the existing payload. The branch
  is one function with the membership check as its only input.
- `app/session/` — the `PATCH` that sets `welcomed_at`.
- `frontend/src/ui/Dialog.tsx` (new) — the shared primitive. Focus trapped
  while open, Esc closes, focus restored to the trigger on close,
  `role="dialog"` with `aria-modal`, and `prefers-reduced-motion` respected.
  Presentational and content-agnostic: it knows nothing about welcoming.
- `frontend/src/welcome/WelcomeDialog.tsx` (new) — the content and the two
  paths. Composes `Dialog`.
- `frontend/src/session/ProfileMenu.tsx` — one new entry.
- `frontend/src/home/HomePage.tsx` — first-run ordering.

The split matters because the dialog primitive will outlive this feature. If
it knows what a welcome is, the next dialog cannot reuse it.

## Error and empty states

- **The welcome block fails to load** — no dialog. Orientation is not worth an
  error message, and Home must still render.
- **The dismissal `PATCH` fails** — the dialog closes anyway and will reappear
  next sign-in. Showing it twice is a smaller harm than refusing to close it.
- **A user with membership but no readable items** — takes the "nothing
  readable" path. What they can see is the question, not what they belong to.

## Accessibility

Not a footnote here, because a modal is the one component that can trap a
keyboard user with no way out:

- Focus moves into the dialog on open and returns to the trigger on close.
- Tab cycles within the dialog while it is open.
- Esc closes it, and the close is persisted exactly as the button is.
- The dialog is labelled by its heading.
- Any transition respects `prefers-reduced-motion`.

## Testing

Backend:

- The branch picks correctly for a user with no membership, a viewer in a
  populated workspace, and an editor in one.
- `welcomed_at` set means the block reports the dialog as already seen.
- The welcome block costs no additional query on the Home payload.
- The dismissal endpoint sets the column, and is idempotent.

Frontend:

- The dialog traps focus and restores it to the trigger.
- Esc dismisses and persists, the same as the button.
- The profile-menu entry reopens it after dismissal.
- Each path renders its own content, and the editor-only advice is absent for
  a viewer.
- Home's first-run ordering flips once the user has content.
