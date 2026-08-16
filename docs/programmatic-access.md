# Programmatic access

Two separate surfaces answer "can I drive this with code?", and they are
worth keeping apart because they have different owners and different
guarantees.

## 1. This application's own REST API

Every screen in this product is a thin client over an HTTP API. There is no
functionality reachable from the UI that is not reachable from a script.

**The contract documents itself.** FastAPI publishes OpenAPI:

- `GET /openapi.json` — the machine-readable spec
- `GET /docs` — the interactive browser

Both are live and currently describe **26 paths**. The ones worth knowing:

| Purpose | Endpoint |
|---|---|
| List semantic views | `GET /api/semantic-views` |
| Describe one (dimensions, metrics, facts) | `GET /api/semantic-views/{db}/{schema}/{name}` |
| Distinct values of a field | `GET /api/semantic-views/{db}/{schema}/{name}/values?field=…` |
| **Run a query** | `POST /api/query/semantic` |
| Saved explores | `GET,POST /api/explores`, `GET,PUT,DELETE /api/explores/{id}` |
| Reports | `GET,POST /api/reports`, `GET,PUT,DELETE /api/reports/{id}` |
| Portable documents | `GET /api/reports/{id}/export`, `GET /api/explores/{id}/export` |
| Import a report | `POST /api/reports/import` |
| Excel workbook | `POST /api/reports/{id}/export.xlsx` |
| SQL for a live Excel connection | `POST /api/reports/{id}/connect` |
| Natural-language question | `POST /api/reports/{id}/ask` |
| Workspaces and members | `/api/workspaces…` |

`POST /api/query/semantic` is the one to reach for first. Its body is the
same shape every visual sends:

```json
{
  "database": "SEMANTIC_DEMO",
  "schema": "TPCH",
  "view": "TPCH_SALES_ANALYTICS",
  "dimensions": ["CUSTOMERS.MARKET_SEGMENT"],
  "metrics": ["CUSTOMERS.CUSTOMER_COUNT"],
  "aggregations": [{ "field": "CUSTOMERS.ACCOUNT_BALANCE", "fn": "avg" }],
  "filters": [
    { "id": "f1", "field": "CUSTOMERS.MARKET_SEGMENT", "op": "is",
      "values": ["AUTOMOBILE"] }
  ],
  "orderBy": [{ "field": "CUSTOMERS.CUSTOMER_COUNT", "direction": "desc" }],
  "limit": 100
}
```

The response carries `columns`, `rows`, `truncated`, `sfqid` and the `sql`
that ran — the SQL is returned deliberately, so an answer can be audited
rather than trusted.

### The honest limitation: authentication is cookie-based

`current_session` reads a session cookie. There is **no API key, token or
service account** today. A script must therefore log in the way a browser
does (`POST /auth/dev-login`, or the OAuth flow) and keep the cookie.

That is a real constraint, and it follows from a deliberate design decision
rather than an oversight: **every query runs on the caller's own Snowflake
credentials**, so there is no service identity for a token to represent. A
machine token would either have to impersonate a person or introduce a
shared credential, and the second is the thing this product was built to
avoid.

If unattended automation is wanted, the smallest honest change is
per-user API tokens that map to the same per-user Snowflake connection —
a token is then an alternative way to present *your own* identity, not a
way around it. That is not built.

## 2. Snowflake's own surface

Semantic views are ordinary Snowflake objects, so they are fully scriptable
without this application at all. Everything below is used by this codebase
and has been run against a real account:

```sql
-- Discovery
SHOW SEMANTIC VIEWS;
DESCRIBE SEMANTIC VIEW my_db.my_schema.my_view;

-- Querying
SELECT * FROM SEMANTIC_VIEW(
  my_db.my_schema.my_view
  DIMENSIONS customers.market_segment
  METRICS customers.customer_count
  WHERE customers.market_segment = ?
);
```

Reach it through any Snowflake client: the Python connector (what this
backend uses), the SQL REST API, SnowSQL, or a driver in your language of
choice.

Three grammar rules inside `SEMANTIC_VIEW(...)` that cost us time to learn,
recorded so they cost nobody else any:

1. **`WHERE` goes inside the call**, after `METRICS`, not after the closing
   paren. The predicate has to apply before aggregation.
2. **`LIKE … ESCAPE` is a syntax error** there. Use `CONTAINS`, `STARTSWITH`
   and `ENDSWITH`, which have no wildcard semantics and need no escaping.
3. **`FACTS` is its own clause**, and when both `FACTS` and `DIMENSIONS`
   appear, every field must come from the same entity — a raw fact carries
   no join path, only `METRICS` do.

Snowflake also offers **Cortex** server-side. This codebase calls
`SNOWFLAKE.CORTEX.COMPLETE` for the Ask feature; Snowflake additionally
publishes Cortex Analyst as a REST service over semantic models, which is
worth evaluating if you want natural-language querying without going
through this application. We have not integrated it.

## Which one to use

- Driving *this product* — its saved explores, reports, workspaces and
  sharing — use the REST API above.
- Driving *the data* with no dependency on this product, from a notebook, a
  dbt job or a scheduler, go straight to Snowflake with `SEMANTIC_VIEW(...)`.
