# Launch kit

Copy to paste into GitHub's settings and into launch posts, plus the
checklist of what must be true before any of it is worth posting.

Everything here assumes the name **Firn** and the repo
`github.com/sathishdgl96/firn`. The namespace facts behind that choice are in
the last section.

---

## 1. GitHub "About" description

The single highest-leverage string in the project. It is what appears in
GitHub search results, in Google's snippet, and on every social card. The
limit is **350 characters**.

**Primary** — front-loads the two terms people actually search for
(`snowflake semantic views`, `xmla`) and states the differentiator before the
feature list:

> Open-source semantic layer for Snowflake. Connect Excel PivotTables and
> Power BI to Snowflake Semantic Views through a real XMLA/MDX endpoint — plus
> a web explorer, reports and dashboards. Every query runs as the signed-in
> user, so Snowflake RBAC stays the only authority on data access. Self-hosted,
> no service account.

**Shorter**, if you want the whole thing visible without truncation on mobile:

> Excel and Power BI on Snowflake Semantic Views, over a real XMLA endpoint.
> Open-source, self-hosted BI with reports, dashboards and a query explorer —
> every query runs as the signed-in user.

**Category-anchored**, for when you want the comparison to do the work:

> An open-source XMLA endpoint for Snowflake Semantic Views. Live Excel
> PivotTables and Power BI on governed metrics, without moving data or sharing
> a service account. Self-hosted, Apache-2.0.

### Why these words

| Term | Why it earns its place |
|---|---|
| `Snowflake Semantic Views` | The exact product name people search. Never shorten it to "semantic views". |
| `XMLA` | Low volume, near-zero competition, extremely high intent. Anyone typing it is qualified. |
| `Excel` / `PivotTable` | The largest under-served BI audience, and the thing that makes people click. |
| `Power BI` | The highest search volume of anything here. |
| `open-source` | The differentiator against the only comparable product. |
| `self-hosted` | Filters for the people who will actually deploy it. |
| `semantic layer` | The category term analysts and buyers use. |

Avoid in the description: "PowerBI-style" (a comparison that makes you sound
like an imitation), "modern", "powerful", "seamless".

---

## 2. Repository topics

GitHub allows 20. These are all real, populated topics — a topic nobody
browses is a wasted slot.

```
snowflake  semantic-layer  business-intelligence  xmla  mdx
power-bi  excel  analysis-services  olap  bi-tool
self-hosted  dashboard  reporting  data-analytics  rbac
sso  fastapi  react  python  typescript
```

---

## 3. README hero

Replace everything above "## Quick start". The current opening buries the
lede: it leads with "PowerBI-style reporting", which describes the least
distinctive thing in the project.

```markdown
<h1 align="center">Firn</h1>

<p align="center">
  <strong>Excel and Power BI on Snowflake Semantic Views, over a real XMLA endpoint.</strong><br>
  Self-hosted. Apache-2.0. Every query runs as the signed-in user.
</p>

<p align="center">
  <a href="LICENSE.md"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Python" src="https://img.shields.io/badge/python-3.12%2B-blue">
  <img alt="Tests" src="https://img.shields.io/badge/tests-967%20passing-brightgreen">
</p>

<p align="center">
  <img src="docs/media/excel-pivot.gif" alt="An Excel PivotTable refreshing live against a Snowflake semantic view" width="720">
</p>

Snowflake Semantic Views put your governed metrics in one place. Firn is the
endpoint that lets the tools your business already uses read them — **Excel
PivotTables and Power BI, connected live over XMLA/MDX**, with no extract, no
cube rebuild, and no service account.

It is also a full analytics application in its own right: a field explorer, a
report builder, dashboards, scheduled exports, and a provenance page showing
who certified a model and how fresh its sources are.

**The property everything rests on:** every query runs on the caller's own
Snowflake connection. There is no shared credential and no cached result set
that one person's role can read out of another's session. Firn cannot widen
anybody's access to data — if Snowflake refuses a user a table, they see that
refusal here, in Snowflake's own words.

### Why not just use...

| | |
|---|---|
| **AtScale** | Closed-source, sold as a quoted annual enterprise licence, and its Snowflake Semantic Views XMLA endpoint was announced in June 2026 as private preview. Firn is Apache-2.0 and runs on your own infrastructure today. |
| **Power BI alone** | Import mode copies your data out of Snowflake and re-implements the metrics in DAX. Firn keeps one definition, in Snowflake, and queries it live. |
| **Metabase / Superset** | Excellent, database-agnostic, and neither speaks XMLA — your Excel users are left out. Both also query through a service account by default. |
| **Snowsight** | Great for analysts already in Snowflake. Firn is for the people who will never leave Excel. |
```

### The GIF

Record one 20–30 second loop: open Excel, Data, From Analysis Services, point
it at your Firn endpoint, drag a measure and two dimensions into a PivotTable,
refresh, numbers change. No narration, no cursor hunting.

This asset will do more for adoption than the next six months of features.
Nothing you write is as persuasive as a Microsoft product being visibly driven
by your server.

---

## 4. Social preview

GitHub renders this at 1280x640 on every link share. Text for it:

> **Firn**
> Excel and Power BI on Snowflake Semantic Views
> Open-source XMLA endpoint · Apache-2.0

Meta description for the docs site, if you publish one (155 characters, the
Google truncation point):

> Open-source XMLA endpoint for Snowflake Semantic Views. Connect Excel and
> Power BI to governed metrics live, self-hosted, with per-user RBAC.

---

## 5. Launch copy

### Show HN

Title (72 characters, under HN's 80 limit):

> Show HN: Firn – Excel and Power BI on Snowflake semantic views over XMLA

First comment. HN rewards the origin story and the honest limitation far more
than the feature list:

> I kept watching analysts export CSVs out of a governed Snowflake model into
> Excel, where every metric got quietly redefined. The metrics layer was
> correct and nobody was using it, because the tool people actually work in
> couldn't reach it.
>
> Firn implements the XMLA/MDX protocol that Excel and Power BI speak natively
> and translates it into queries against Snowflake Semantic Views. Excel thinks
> it's talking to Analysis Services. It's talking to Snowflake.
>
> The design constraint I'm most attached to: there is no service account.
> Every query runs on the caller's own Snowflake connection, so the app is
> structurally incapable of widening anyone's data access. Sharing a report
> shares the definition, never the numbers.
>
> Honest limitations: Snowflake-only, single maintainer, and MDX coverage is
> the subset Excel PivotTables actually emit rather than the full grammar.
> AtScale announced a commercial version of this in June; theirs is private
> preview and closed. Happy to answer anything.

### r/snowflake and r/dataengineering

> **I built an open-source XMLA endpoint for Snowflake Semantic Views, so Excel
> can query them directly**
>
> Semantic Views solved the "one definition of revenue" problem, but the people
> who most need one definition of revenue live in Excel, and Excel can't see
> them. So I implemented the protocol Excel does speak.
>
> Live PivotTables against Semantic Views, no extract, no cube rebuild. Each
> user connects with their own Snowflake credentials, so RBAC and row access
> policies apply exactly as they do in Snowsight — no service account anywhere
> in the design.
>
> There's also a web app on top: explorer, report builder, dashboards, model
> certification and a freshness/provenance page.
>
> Apache-2.0, self-hosted. I'd genuinely like to hear where the MDX coverage
> breaks for your workbooks.

### LinkedIn

> Snowflake Semantic Views gave us one governed definition of every metric.
> Then everyone exported to Excel and redefined them anyway.
>
> That's not a discipline problem. It's a connectivity problem: the semantic
> layer wasn't reachable from the tool the business actually uses.
>
> So I built Firn — an open-source XMLA endpoint that lets Excel and Power BI
> query Snowflake Semantic Views live. Excel believes it's connected to
> Analysis Services. It's connected to Snowflake, with the user's own
> credentials, under the user's own role.
>
> Apache-2.0 and self-hosted. Link in comments.

LinkedIn suppresses posts with outbound links in the body — put the repo URL
in the first comment.

### Where to post

Ranked by expected qualified attention, not raw reach:

1. **r/snowflake** — smallest audience, highest concentration of exactly the
   right people.
2. **Snowflake community forum** and the Snowflake user Slack.
3. **Show HN** — post Tuesday to Thursday, 8-10am US Eastern.
4. **dbt Community Slack** `#tools-and-integrations`, and Locally Optimistic
   Slack.
5. **r/dataengineering** and **r/PowerBI** (the Excel angle plays especially
   well there).
6. **LinkedIn** — the analytics-engineering crowd lives there, and this is the
   one that most helps you professionally.

Do not post to all of these on the same day. Space them a week apart so one
bad launch doesn't burn every channel.

---

## 6. Before you post anything

Ordered by how much each one costs you if skipped.

- [x] **LICENSE.md** — Apache-2.0. Without it the repo is legally "all rights
      reserved" and nobody may use it.
- [x] **NOTICE** — copyright, plus the Microsoft and Snowflake trademark
      disclaimers.
- [x] **CODE_OF_CONDUCT.md** — Contributor Covenant 2.1.
- [x] **Vulnerability reporting policy** — in `docs/SECURITY.md`.
- [ ] **A demo that needs no Snowflake account.** `docker compose up` into
      fixture data and fake semantic views. This is the single biggest
      determinant of whether stars convert into users. Today everyone who
      clicks through has to own a Snowflake account with Semantic Views and
      configure OAuth before they see one screen. Almost nobody will.
- [ ] **The Excel GIF** at the top of the README.
- [ ] **Rename the codebase** from SemanticUI to Firn (see below).
- [ ] **Rewrite the README hero** using section 3.
- [ ] **Set the About text and topics** from sections 1 and 2.
- [ ] **Confirm you own the copyright.** If any of this was written on employer
      time or equipment, your employment agreement may assign it to them. Get
      written sign-off before publishing — this is the one item on the list
      that cannot be undone afterwards.

---

## 7. The name

**Firn** is the compacted granular snow that forms the intermediate stage
between fresh snowfall and glacial ice. A glaciology term in the public domain,
and a fair description of what the project is: the layer between raw tables and
a solid governed model.

What was actually checked, and what it means:

| Namespace | State | Does it matter? |
|---|---|---|
| `github.com/sathishdgl96/firn` | **Free** | Yes. This is the canonical identity of an open-source project, and it's clear. |
| GitHub org `/firn` | Taken — dormant user, 0 repos, inactive since 2021 | No. A personal namespace is the norm for solo projects. |
| PyPI `firn` | Taken — an unrelated hybrid-search library | Barely. The backend is an application installed from source, not a published package. Publish as `firn-bi` if that ever changes. |
| npm `firn` | Taken — a visual-regression tool, abandoned since 2022 | No. `frontend/package.json` is `private: true` and never publishes. |
| `firn.dev` / `.io` / `.com` / `.app` / `.sh` | All registered | Only if you want a docs domain. `firnhq.com`, `firnbi.com`, `usefirn.com` and `firnlayer.com` were unregistered when checked. |
| Trademark | No software mark for "Firn" surfaced | Probably clear, but a search is not a clearance opinion. See below. |

**On trademarks.** No registered software mark for "Firn" turned up, and the
word is a common glaciological term, which weakens anyone's claim to it as a
brand. That is reassuring, but it is not legal advice and it is not a
clearance search. If Firn ever earns revenue, pay a trademark attorney
(roughly $300-800) for a real opinion in classes 9 and 42 before building a
brand on it. For an unmonetised open-source project the practical risk is low.

**What you must not do:** name it `SnowFirn`, `Firn for Snowflake`, or
anything that could imply endorsement. Snowflake's trademark policy
discourages `Snow*` product names. "Works with Snowflake" is nominative fair
use and is fine; looking like a Snowflake product is not.

**Why not the current name.** `SemanticUI` collides head-on with Semantic UI,
a ~51k-star CSS framework that every frontend developer knows, with an active
fork and the npm name long since taken. You would be invisible in search, and
everyone who did find you would arrive confused.

### Renaming the codebase

572 occurrences across 82 files. Three tiers, in ascending order of risk:

1. **Cosmetic** — docs, page titles, comments. Safe and mechanical.
2. **Identifiers** — `semanticui-backend` in `pyproject.toml`, the Docker image
   name. Safe, but rebuild containers.
3. **Load-bearing and breaking** — the `SEMANTICUI_*` environment variables
   (`config.py` sets `env_prefix`), and the `semanticui_session` /
   `semanticui_oauth_state` cookie names. Renaming the prefix invalidates every
   existing `.env`. Renaming the cookies signs out every active session.

Do tier 3 in a single commit with a changelog note and accept the forced
re-login — or read both prefixes for one release, if anyone but you is already
running it.

---

## 8. Trademark and policy compliance

Firn names Snowflake, Microsoft, Excel and Power BI throughout. That is
**nominative fair use** — you cannot describe what this software does without
naming what it connects to — and it is permitted provided three conditions
hold. All three currently hold; keep them holding.

1. **Use only as much of the mark as needed.** The word "Snowflake" in a
   sentence, never the logo, never the brand's colours or typography.
2. **Never imply endorsement, sponsorship or affiliation.**
3. **Keep the disclaimer visible.** It is in `NOTICE`.

### Do not

| | Why |
|---|---|
| "Powered by Snowflake" | A formal Snowflake partner programme with its own brand guide and enrolment. Using the phrase without being in it claims a status you do not have. |
| The Snowflake logo or snowflake mark | Reserved for partners and editorial use under Snowflake's brand guidelines. |
| Snowflake's brand colours or type on your social preview | Same reasoning — visual imitation implies affiliation more strongly than words do. |
| `SnowFirn`, `Firn for Snowflake`, any `Snow*` product name | Snowflake's guidelines discourage it, and a mark inside a product name is not nominative use. |
| "Certified", "official", "native" | All of these are terms of art in Snowflake's partner programmes. |

"Works with Snowflake", "connects to Snowflake", "for use with Snowflake
Semantic Views" are all fine. Snowflake enforces most actively against
competitive or misleading use — accuracy is the defence.

### Comparative claims

The "Why not just use..." table names four competing products. Comparative
claims are lawful when **truthful and substantiated**, and a liability when
not. Every row must stay checkable:

- Say "quoted annual enterprise licence", not a made-up price. AtScale
  publishes no price list and states it does not charge per seat.
- Date every claim about a competitor's product state. "Announced June 2026 as
  private preview" ages honestly; "is in private preview" becomes false the day
  it ships.
- Re-verify the whole table the week you launch.

### Dependency licences

Everything shipped is compatible with distributing Firn under Apache-2.0:

| Dependency | Licence | Note |
|---|---|---|
| `snowflake-connector-python` | Apache-2.0 | Snowflake's own connector, permissively licensed. Nothing is vendored. |
| `fastapi`, `sqlalchemy`, `alembic`, `pydantic-settings` | MIT | |
| `cryptography` | Apache-2.0 OR BSD-3-Clause | |
| `psycopg[binary]` | **LGPL-3.0-only** | Fine: it is a pip-installed dependency imported at runtime, not vendored or statically linked, and users can replace it. Do not bundle it into a single-file binary without checking. |
| Frontend (react, echarts, react-grid-layout, xyflow, dnd-kit, tanstack-query) | MIT / Apache-2.0 | |

