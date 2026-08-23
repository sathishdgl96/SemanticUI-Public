# Contributing

The goal of this guide: clone → running → tested → first PR inside an
hour. If any step takes longer, that is a bug in this document — fix it
in the same PR as whatever brought you here.

## Run it

```bash
# Prereqs: Python 3.12+, Node 22+, a Snowflake account for live work
python dev.py setup       # venv, deps, alembic upgrade, npm install
python dev.py run         # backend (random port) + Vite on 5173, proxied
```

Open http://localhost:5173 and sign in with your own Snowflake
credentials (dev mode). Configuration lives in `backend/.env`
(`SEMANTICUI_*`; see `backend/.env.example`). No `.env` secrets ever get
committed — CI runs gitleaks over full history.

The deploy shape (containerized, Postgres) is `docker compose up --build`
→ http://localhost:8080. Development stays on `dev.py` for hot reload.

## Test it

```bash
cd backend && python -m pytest -q        # ~740 tests, seconds
python -m ruff check app tests           # lint floor: syntax/undefined/unused
cd frontend && npm test -- --run         # ~470 tests
npx tsc --noEmit && npm run lint
```

CI (`.github/workflows/ci.yml`) runs all of the above plus pip-audit,
npm audit and gitleaks — red blocks merge. Integration tests that need a
real Snowflake account are behind the `integration` marker and env-gated.

## Find your way

Read these two first — they are kept current on purpose and updating
them is part of any PR that changes a boundary they draw:

- `docs/architecture/high-level.md` — what the system is, the four
  client paths, the security model.
- `docs/architecture/low-level.md` — package map, request flows, the
  XMLA protocol contract, DB schema.

The decisions behind the shape of the system live in
`docs/architecture/decisions/` — read the relevant ADR before proposing
a change that touches one, and add an ADR in the same PR when your
change makes a decision the next developer would otherwise reverse.

House rules that are easy to trip over:

1. **Every query runs on the caller's own Snowflake connection.** There
   is no service account. Anything that would add one is an architecture
   conversation, not a PR.
2. **Values are bound, never SQL text.** Filters, member keys, feed
   parameters — all placeholders. Tests assert values never appear in
   SQL; keep it that way.
3. **Never log data.** Field REFERENCES, durations, query ids: yes.
   Row values, filter values, tokens: never. `tests/test_logging.py`
   greps captured logs for leaks and will fail your PR.
4. **404 for non-members, 403 for low roles.** The feed and API must not
   reveal which resources exist. `require_owned` is the single gate; do
   not add a second.
5. **The two catalogs mirror each other** (`backend/app/reports/catalog.py`
   ↔ `frontend/src/reports/catalog.ts`) with shared-expectation tests as
   the drift guard. Change both or the tests will tell you.
6. **`frontend/src/query/palette.ts` is order-sensitive** — never
   reorder it.
7. **Docs ship with code.** Same PR, or it does not merge.

## Working on the XMLA adapter (read before touching it)

MSOLAP's failure mode is a hang or a generic HRESULT — never a message.
The workflow that cracked it, and the only sane way to keep working on
it:

1. `SEMANTICUI_XMLA_TRACE=<file>` writes verbatim request/response pairs
   (request ids included, Authorization redacted). Development only —
   production refuses the flag.
2. Drive real Excel over COM (see `docs/superpowers/manual-passes/
   2026-08-18-xmla-pivot.md` for the scripts' shape) — Excel is the
   ground truth for OOXML artifacts and the XMLA handshake.
3. ADOMD.NET (NuGet, no install) speaks the same protocol with TEXTUAL
   errors — use it to iterate before re-driving Excel.
4. Validate responses against their own embedded XSD with lxml when the
   client rejects something silently.
5. Wire captures become test fixtures verbatim. The protocol rules that
   are load-bearing are listed in `docs/architecture/low-level.md`.

## Style

- Python: ruff-checked; comments explain constraints the code cannot
  show, never narrate the next line. Module docstrings state intent —
  keep them true.
- TypeScript: strict; testing-library over implementation details.
- Commits: imperative subject, a body that says WHY. Every commit leaves
  the suites green.
