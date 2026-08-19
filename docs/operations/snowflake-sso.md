# Snowflake SSO Setup (Security Integration)

The production auth path: users sign in through the corporate IdP, the
browser holds a short-lived token (never the server), and Snowflake
accepts those tokens via a security integration. This runbook wires a
fresh Snowflake account end to end. Dev-login (password/key-pair) is a
development mode; production refuses it at startup.

## Architecture decision recap

- The SPA is a **public client** of the IdP: authorization code + PKCE,
  no client secret in the browser.
- Snowflake is configured for **External OAuth**: it validates the IdP's
  tokens directly. This is the pairing that lets the browser hold the
  token; Snowflake-native OAuth issues a client secret and expects a
  confidential client, which a browser cannot be.
- Excel connect tokens are separate PAT-style credentials (see the
  enterprise-readiness plan, A2.1); their delegated grants are the only
  credentials the server persists.

## 1. IdP application (example: Entra ID)

1. App registration → single-page application platform, redirect URI
   `https://<app-host>/auth/callback` (and `http://localhost:5173/auth/callback`
   for development).
2. Enable **Authorization Code + PKCE**; do NOT create a client secret
   for the SPA registration.
3. Expose an API scope for Snowflake (Entra: use the Snowflake
   enterprise-app pattern — scope `session:scope:analyst` or your role
   scope), and grant your users/groups.
4. Token lifetimes: access token 15–60 min. Refresh handled by the IdP's
   SPA rotation policy.

Okta and other OIDC IdPs follow the same shape: SPA app, PKCE, a custom
authorization server issuing tokens with the Snowflake audience.

## 2. Snowflake security integration (External OAuth)

Run as ACCOUNTADMIN, values from your IdP metadata:

```sql
CREATE SECURITY INTEGRATION IF NOT EXISTS semanticui_external_oauth
  TYPE = EXTERNAL_OAUTH
  ENABLED = TRUE
  EXTERNAL_OAUTH_TYPE = AZURE            -- or OKTA / CUSTOM
  EXTERNAL_OAUTH_ISSUER = 'https://login.microsoftonline.com/<tenant>/v2.0'
  EXTERNAL_OAUTH_JWS_KEYS_URL = 'https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys'
  EXTERNAL_OAUTH_AUDIENCE_LIST = ('<application-id-uri>')
  EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM = 'upn'   -- claim that names the user
  EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE = 'LOGIN_NAME'
  -- High-privilege roles stay unusable through this integration:
  EXTERNAL_OAUTH_BLOCKED_ROLES_LIST = ('ACCOUNTADMIN', 'SECURITYADMIN');
```

Checklist:

- [ ] The mapping claim's value matches each user's `LOGIN_NAME`
      (Snowflake users are usually provisioned from the same IdP via
      SCIM — do that first if not).
- [ ] `EXTERNAL_OAUTH_BLOCKED_ROLES_LIST` reviewed — the app should never
      operate with administrative roles.
- [ ] A **network policy** on the integration restricting token use to
      the app's egress addresses (defense against stolen tokens):

```sql
CREATE NETWORK POLICY semanticui_app_only ALLOWED_IP_LIST = ('<app-egress-cidr>');
ALTER SECURITY INTEGRATION semanticui_external_oauth
  SET NETWORK_POLICY = semanticui_app_only;   -- if supported on your edition
```

## 3. App configuration

Setting `OAUTH_AUTHORIZE_URL` and `OAUTH_TOKEN_URL` is what switches
sign-in from Snowflake-hosted OAuth to your IdP. Without them the app
talks to `https://<account>.snowflakecomputing.com/oauth/...` and your
IdP is never involved.

```bash
SEMANTICUI_AUTH_MODE=oauth
SEMANTICUI_ENVIRONMENT=production
# The account queries run against, whoever issued the token:
SEMANTICUI_SNOWFLAKE_ACCOUNT=<org-account>
SEMANTICUI_OAUTH_REDIRECT_URI=https://<app-host>/auth/callback

# From the Entra app registration:
SEMANTICUI_OAUTH_CLIENT_ID=<Application (client) ID>
SEMANTICUI_OAUTH_CLIENT_SECRET=<the secret VALUE, not its Secret ID>
SEMANTICUI_OAUTH_AUTHORIZE_URL=https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize
SEMANTICUI_OAUTH_TOKEN_URL=https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token
SEMANTICUI_OAUTH_SCOPE=api://<app-id-uri>/session:role:analyst offline_access
```

Where each value is in the Azure portal (App registrations → your app):

| Setting | Where |
|---|---|
| `OAUTH_CLIENT_ID` | Overview → **Application (client) ID** |
| tenant id in the URLs | Overview → **Directory (tenant) ID** |
| `OAUTH_CLIENT_SECRET` | Certificates & secrets → New client secret → copy the **Value** immediately (it is never shown again) |
| `OAUTH_REDIRECT_URI` | Authentication → Redirect URIs → add this exact URL, platform **Web** |
| `OAUTH_SCOPE` | API permissions → the Snowflake scope you exposed; `offline_access` is required or no refresh token is issued |

Both endpoint URLs are also listed under **Endpoints** at the top of the
app registration's Overview page.

Notes:

- Platform must be **Web**, not Single-page application: this flow
  completes on the server (`/auth/callback`), where the secret lives.
  A SPA registration is for plan item S2 and holds no secret — the app
  accepts a missing secret only when an IdP is configured, because PKCE
  protects the code.
- The redirect URI must match **character for character**, trailing
  slash included.
- Okta and other OIDC IdPs use the same three settings pointed at their
  own authorize/token endpoints.

Production startup refuses: dev auth mode, the default secret key, a
localhost database, and the XMLA trace flag.

## 4. Verify

1. Browser: visit the app → redirected to the IdP → back at the app,
   signed in; `/api/me` names your Snowflake identity.
2. Run any report: `audit_events` gains `report.read`; the log stream
   carries the request id; the Snowflake query id in the log matches
   `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` (user = YOU, not a service
   account).
3. Idle an hour → next click bounces silently through the IdP.

## 4b. Troubleshooting (every trap this actually hit)

Sign-in has three legs, and only the last one involves Snowflake. The
app's 401 detail (development only) and its log line name the leg.

**Snowflake's own verifier is the fastest instrument.** It explains a
refusal in one word instead of a guess:

```sql
SELECT SYSTEM$VERIFY_EXTERNAL_OAUTH_TOKEN('<an access token>');
-- {"Validation Result":"Failed","Failure Reason":"EXTERNAL_OAUTH_USER_CLAIM_MISSING"}
```

An app-only token (client credentials) is enough to prove the issuer,
audience and signature are right — it simply carries no user claim, so
that one reason is expected and everything else passing is the signal.

| Symptom | Cause |
|---|---|
| `390303 Invalid OAuth access token` | Issuer, audience or signature mismatch — or the token carries no user claim at all. |
| `390100 Incorrect username or password` | The token VALIDATED; the mapped claim's value matches no Snowflake user. This is a mapping problem, never a password. |
| `None:` in the middle of a Snowflake error | Not a username. It is `sfqid`, which the connector interpolates whenever the logger sits at INFO/DEBUG and which is absent during a failed login. Ignore it. |

Three configuration traps, all of which produce the same 390100:

1. **Mapping an opaque claim.** Entra's `sub` is a pairwise GUID, not a
   name; nothing in Snowflake will ever equal it. Map `upn` (or `email`)
   and confirm it appears in the ACCESS token — the ID token is not what
   Snowflake sees. Optional claims are added under App registration →
   Token configuration → **Access token**.
2. **Mapping onto `LOGIN_NAME` when passwords are still in use.**
   Changing `LOGIN_NAME` to an email address changes how that user signs
   in everywhere, breaking password and key-pair logins that used the
   old name. Prefer `EXTERNAL_OAUTH_SNOWFLAKE_USER_MAPPING_ATTRIBUTE =
   'EMAIL_ADDRESS'` and set the user's `EMAIL`, which nothing else reads.
3. **No usable role.** With `EXTERNAL_OAUTH_ANY_ROLE_MODE = DISABLE` the
   token's `scp` must name a role that EXISTS and is GRANTED to the
   user, and that role must not be on the blocked list. A brand-new
   account typically grants its owner only ACCOUNTADMIN — which is
   blocked, correctly — so SSO has nothing to run as until an ordinary
   role is created:

```sql
CREATE ROLE IF NOT EXISTS ANALYST;               -- matches session:role:analyst
GRANT ROLE ANALYST TO USER <user>;
GRANT USAGE ON WAREHOUSE <wh> TO ROLE ANALYST;
GRANT USAGE ON DATABASE <db> TO ROLE ANALYST;
GRANT USAGE ON SCHEMA <db>.<schema> TO ROLE ANALYST;
GRANT SELECT ON ALL SEMANTIC VIEWS IN SCHEMA <db>.<schema> TO ROLE ANALYST;
```

## 5. Revocation (the kill switch)

Per user, at the Snowflake side — works even if the app is compromised:

```sql
ALTER USER <login_name> REMOVE DELEGATED AUTHORIZATIONS
  FROM SECURITY INTEGRATION semanticui_external_oauth;
```

Disable the whole path: `ALTER SECURITY INTEGRATION ... SET ENABLED = FALSE;`
