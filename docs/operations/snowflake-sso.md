# Single sign-on: app registration and security integration

The production sign-in path, end to end, from a fresh Snowflake account
and a fresh IdP tenant. Follow it in order — every step depends on a value
the one before it produced.

Dev-login (password / key-pair) is a development mode. Production refuses
anything but key-pair at startup, and an unconfigured install offers
single sign-on only.

Allow about 30 minutes. You need **Application Administrator** (or
Global Administrator) in the IdP tenant and **ACCOUNTADMIN** in Snowflake.

---

## What you are building

```
browser ──1── IdP sign-in page
   │                 │
   │                 └──2── redirects to  <backend>/auth/callback?code=…
   │
   └──5── session cookie          3── backend exchanges the code
                                      (PKCE verifier + client secret)
                                            │
                                            4── Snowflake accepts the
                                                token via the security
                                                integration
```

**The browser never holds a Snowflake token.** The backend is a
*confidential client*: it performs the code exchange and keeps the token
server-side, encrypted. That is why the IdP registration below is a **Web**
platform with a client secret, and why the redirect URI points at the
**backend**, not at the SPA dev server.

PKCE is used as well as the secret. Belt and braces: the secret proves the
backend, the verifier proves the exchange belongs to the browser that
started it.

---

## 1. Register the application (Entra ID)

Okta and other OIDC providers follow the same shape; the names differ.

### 1.1 Create the registration

**Azure portal → Microsoft Entra ID → App registrations → New registration**

| Field | Value |
|---|---|
| Name | `SemanticUI` |
| Supported account types | *Accounts in this organizational directory only* |
| Redirect URI | **Web** → `http://localhost:8100/auth/callback` |

The platform must be **Web**, not Single-page application. An SPA-type
redirect URI makes Entra require a browser `Origin` header on the token
call and refuse a client secret — and the backend, which is doing the
exchange, sends neither.

Add the production URI too, under **Authentication → Add URI**:
`https://<your-host>/auth/callback`. The path is fixed; the host and port
are whatever `SEMANTICUI_OAUTH_REDIRECT_URI` says.

From the **Overview** blade, copy:

- **Application (client) ID** → `SEMANTICUI_OAUTH_CLIENT_ID`
- **Directory (tenant) ID** → used to build the two URLs below

### 1.2 Create a client secret

**Certificates & secrets → Client secrets → New client secret**

Copy the **Value** (not the Secret ID) immediately — Entra shows it once.
→ `SEMANTICUI_OAUTH_CLIENT_SECRET`

Note the expiry. A rotated secret is a sign-in outage if nobody is
watching for it.

### 1.3 Expose the Snowflake role scopes

This is the step people miss. Snowflake decides which role a token may
use from the scopes inside it, so the scopes have to exist in the IdP.

**Expose an API → Application ID URI → Set → Save** — accept the default
`api://<client-id>`.

Then **Add a scope**, once per Snowflake role you want reachable:

| Field | Value |
|---|---|
| Scope name | `session:role:analyst` |
| Who can consent | Admins and users |
| Admin consent display name | `Use the ANALYST role in Snowflake` |
| State | Enabled |

> **There is no wildcard.** `session:role:*` and `session:role:READ_*` are
> not scope patterns — Entra treats a scope name as a literal string and
> Snowflake matches it literally. One scope per role, or use
> `EXTERNAL_OAUTH_ANY_ROLE_MODE = ENABLE` (§2.3) and let the token carry
> no role scope at all.

The full scope string is the URI plus the name:
`api://<client-id>/session:role:analyst`

### 1.4 Let the app request its own scopes

**API permissions → Add a permission → My APIs → SemanticUI →
Delegated permissions →** tick `session:role:analyst` → **Add
permissions**.

Then **Grant admin consent for \<tenant\>**, so each user is not prompted
individually.

### 1.5 Put the user's name in the ACCESS token

Snowflake reads the **access** token. Entra does not include `upn` there
by default, and a token without it fails with a message that sounds like
a password problem (see §5).

**Token configuration → Add optional claim → Token type: Access →** tick
`upn` → **Add**. If Entra offers to turn on the Microsoft Graph
`profile` permission, accept.

> Do not map `sub`. Entra's `sub` is a pairwise GUID — unique per
> application — so nothing in Snowflake will ever equal it.

### 1.6 Assign your users

**Enterprise applications → SemanticUI → Users and groups → Add user/group.**

---

## 2. Create the Snowflake security integration

Run as `ACCOUNTADMIN`.

### 2.1 An ordinary role to run as

A fresh Snowflake account grants its owner `ACCOUNTADMIN` and little
else — and `ACCOUNTADMIN` is correctly blocked below. Without an ordinary
role, sign-in succeeds and then has nothing to run as.

```sql
CREATE ROLE IF NOT EXISTS ANALYST;          -- matches session:role:analyst
GRANT ROLE ANALYST TO USER <user>;

GRANT USAGE ON WAREHOUSE <wh>              TO ROLE ANALYST;
GRANT USAGE ON DATABASE  <db>              TO ROLE ANALYST;
GRANT USAGE ON SCHEMA    <db>.<schema>     TO ROLE ANALYST;
GRANT SELECT ON ALL SEMANTIC VIEWS IN SCHEMA <db>.<schema> TO ROLE ANALYST;
-- And for views created later:
GRANT SELECT ON FUTURE SEMANTIC VIEWS IN SCHEMA <db>.<schema> TO ROLE ANALYST;
```

### 2.2 Match the token's user to a Snowflake user

The `upn` claim carries an email address, so map it to the Snowflake
user's `EMAIL` attribute:

```sql
ALTER USER <user> SET EMAIL = 'first.last@yourcompany.com';   -- = the upn
```

> **Do not map onto `LOGIN_NAME`** unless nobody signs in with a
> password. Changing `LOGIN_NAME` changes how that user authenticates
> *everywhere*, breaking existing password and key-pair logins.
> `EMAIL_ADDRESS` is read by nothing else, which is why §2.3 uses it.

### 2.3 The integration

```sql
CREATE SECURITY INTEGRATION IF NOT EXISTS semanticui_external_oauth
  TYPE = EXTERNAL_OAUTH
  ENABLED = TRUE
  EXTERNAL_OAUTH_TYPE = AZURE                      -- or OKTA / CUSTOM
  EXTERNAL_OAUTH_ISSUER = 'https://sts.windows.net/<tenant-id>/'
  EXTERNAL_OAUTH_JWS_KEYS_URL =
    'https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys'
  EXTERNAL_OAUTH_AUDIENCE_LIST = ('api://<client-id>')

  -- Which claim names the person, and what it is matched against.
  EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = 'upn'
  EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'EMAIL_ADDRESS'

  -- Administrative roles stay unreachable through this path.
  EXTERNAL_OAUTH_BLOCKED_ROLES_LIST = ('ACCOUNTADMIN', 'SECURITYADMIN', 'ORGADMIN');
```

**The issuer must match the token exactly.** Entra has two: v1 tokens say
`https://sts.windows.net/<tenant>/` (with the trailing slash), v2 tokens
say `https://login.microsoftonline.com/<tenant>/v2.0`. Which you get
depends on the `accessTokenAcceptedVersion` in the app manifest. Decode a
real token at [jwt.ms](https://jwt.ms) and copy the `iss` claim verbatim
rather than guessing.

**Roles.** With the default `EXTERNAL_OAUTH_ANY_ROLE_MODE = DISABLE`, the
token's `scp` claim must name a role that exists, is granted to the user,
and is not blocked. To let any granted role be used instead — simpler, and
still bounded by Snowflake's own grants:

```sql
ALTER SECURITY INTEGRATION semanticui_external_oauth
  SET EXTERNAL_OAUTH_ANY_ROLE_MODE = 'ENABLE';
```

### 2.4 Optional: pin token use to the app's addresses

Defence against a stolen token being replayed from elsewhere.

```sql
CREATE NETWORK POLICY semanticui_app_only
  ALLOWED_IP_LIST = ('<app-egress-cidr>');
ALTER SECURITY INTEGRATION semanticui_external_oauth
  SET NETWORK_POLICY = semanticui_app_only;   -- if supported on your edition
```

---

## 3. Configure the app

In `backend/.env`. Setting `OAUTH_AUTHORIZE_URL` and `OAUTH_TOKEN_URL` is
what switches sign-in from Snowflake-hosted OAuth to your IdP; without
them the app talks to `https://<account>.snowflakecomputing.com/oauth/…`
and the integration above is never consulted.

```bash
SEMANTICUI_AUTH_MODE=oauth

# The account queries run against, whoever issued the token:
SEMANTICUI_SNOWFLAKE_ACCOUNT=<org>-<account>

# From the app registration:
SEMANTICUI_OAUTH_CLIENT_ID=<application-client-id>
SEMANTICUI_OAUTH_CLIENT_SECRET=<the secret VALUE from 1.2>
SEMANTICUI_OAUTH_AUTHORIZE_URL=https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize
SEMANTICUI_OAUTH_TOKEN_URL=https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token

# The scope from 1.3, plus offline_access for a refresh token. Without
# offline_access an idle session ends in a full sign-in rather than a
# silent bounce.
SEMANTICUI_OAUTH_SCOPE=api://<client-id>/session:role:analyst offline_access

# Must equal a redirect URI registered in 1.1, character for character.
SEMANTICUI_OAUTH_REDIRECT_URI=http://localhost:8100/auth/callback
```

Where each value comes from:

| Setting | Portal location |
|---|---|
| `OAUTH_CLIENT_ID` | App registration → Overview → Application (client) ID |
| `OAUTH_CLIENT_SECRET` | Certificates & secrets → the **Value** column |
| `OAUTH_AUTHORIZE_URL` / `OAUTH_TOKEN_URL` | Overview → Endpoints → OAuth 2.0 v2 endpoints |
| `OAUTH_SCOPE` | Expose an API → the scope's full name |
| `OAUTH_REDIRECT_URI` | Authentication → Redirect URIs |

Restart the backend. Configuration is read once at startup.

---

## 4. Verify

1. **The integration exists and is enabled:**
   ```sql
   DESCRIBE SECURITY INTEGRATION semanticui_external_oauth;
   ```
2. **Sign in.** The app redirects to the IdP and back; `/api/me` names
   your Snowflake identity and `mode` is `oauth`.
3. **Run a report.** `audit_events` gains a `query.run`, and the Snowflake
   query id in the log matches a row in
   `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` whose user is **you** — not a
   service account. That is the whole architecture, visible in one row.
4. **Idle an hour.** The next click bounces silently through the IdP,
   which is what `offline_access` bought.

---

## 5. Troubleshooting (every trap this actually hit)

Sign-in has three legs and only the last involves Snowflake. The app's
401 detail (development only) and its log line name the leg.

**Snowflake's own verifier is the fastest instrument** — it explains a
refusal in one word instead of a guess:

```sql
SELECT SYSTEM$VERIFY_EXTERNAL_OAUTH_TOKEN('<an access token>');
-- {"Validation Result":"Failed","Failure Reason":"EXTERNAL_OAUTH_USER_CLAIM_MISSING"}
```

An app-only token (client credentials) is enough to prove the issuer,
audience and signature are right — it carries no user claim, so *that*
one failure is expected and everything else passing is the signal.

| Symptom | Cause |
|---|---|
| `AADSTS50011 redirect URI mismatch` | The `.env` value and the registered URI differ — a trailing slash, `http` vs `https`, or the wrong port. They must match character for character. |
| `AADSTS65001 consent` | §1.4's admin consent was not granted. |
| `AADSTS9002326 Cross-origin token redemption…` | The redirect URI was registered under the **SPA** platform. It has to be **Web** — see §1.1. |
| `390303 Invalid OAuth access token` | Issuer, audience or signature mismatch — or the token carries no user claim at all. Decode it at jwt.ms and compare `iss` and `aud` with §2.3. |
| `390100 Incorrect username or password` | The token **validated**; the mapped claim matches no Snowflake user. A mapping problem, never a password. |
| `None:` inside a Snowflake error | Not an empty username. It is `sfqid`, which the connector interpolates whenever its logger sits at INFO/DEBUG and which is absent during a failed login. Ignore it. |
| Signed in, but every query fails on the warehouse | The role from §2.1 has no `USAGE` on a warehouse, or the session picked a role that does not. |

Three configuration traps, all of which produce the same `390100`:

1. **Mapping an opaque claim.** Entra's `sub` is a pairwise GUID. Map
   `upn` (or `email`) and confirm it is in the **access** token — the ID
   token is not what Snowflake sees.
2. **Mapping onto `LOGIN_NAME` while passwords are still in use.** See
   §2.2.
3. **No usable role.** See §2.1 and `EXTERNAL_OAUTH_ANY_ROLE_MODE`
   in §2.3.

---

## 6. Revocation (the kill switch)

Per user, at the Snowflake side — works even if the app is compromised:

```sql
ALTER USER <login_name> REMOVE DELEGATED AUTHORIZATIONS
  FROM SECURITY INTEGRATION semanticui_external_oauth;
```

Disable the whole path:

```sql
ALTER SECURITY INTEGRATION semanticui_external_oauth SET ENABLED = FALSE;
```

Both take effect on the next token presentation. Existing app sessions
survive until their Snowflake connection is next rebuilt, so revoke the
app session too if the concern is immediate:

```sql
-- from the app's database
DELETE FROM sessions WHERE user_id = '<user-id>';
```
