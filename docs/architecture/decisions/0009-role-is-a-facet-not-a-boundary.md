# 0009 — A Snowflake role is a facet, not a boundary

Status: Accepted

## Context

A power user holding ten Snowflake roles accumulates hundreds of saved
reports and explores, and everything saved without naming a workspace
lands in one personal workspace. Finding anything becomes the problem.

The first proposal scoped workspaces to Snowflake roles and hid the
ones that did not match the role you were currently in.

## Decision

Membership remains the only rule for both access and visibility. A
Snowflake role is recorded on saved items as provenance and offered as
a **visible, clearable filter chip**, alongside search, recents and
favourites.

The role and warehouse a session runs as are a separate concern —
execution context, switchable from the profile menu and remembered
across logins. They change what a query returns. They do not change
what is listed.

## Why not scope workspaces by role

- **It would create a second permission system.** Access would be
  membership and visibility would be role, so "I am a member, why can't
  I see it?" becomes the common question — answered by a mode that is
  not visible from the list being looked at.
- **It would hide without protecting.** Access stays membership, so a
  member in the "wrong" role could still open the item by URL. A filter
  dressed as a boundary is worse than either one alone, because someone
  will eventually trust it as security.
- **A role is the wrong shape.** It answers "what data may I read";
  a workspace answers "where does this work live". A Finance workspace
  may legitimately be read by FINANCE and AUDITOR both, and people hold
  several roles at once, so "current role" is a mode, not an identity.

## Consequences

- One mental model: if you are a member, you can see it, always.
- A filter cannot be mistaken for a boundary, because the chip states
  what is being hidden and one click removes it.
- Facets may only narrow. They are applied after the membership join,
  and a test asserts that no combination of browse parameters reveals
  another user's work.
- Free-form labels can replace or join the role facet later without a
  migration, since a facet is only a filter chip. If role turns out not
  to be the axis people group by, nothing structural has to change.
- Role-based access control remains available as a future decision and
  would supersede this one. That is the coherent answer if regulated
  separation is ever required — "Finance must not know Sales
  workspaces exist" needs a boundary, not a facet.
