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

```bash
SEMANTICUI_AUTH_MODE=oauth
SEMANTICUI_ENVIRONMENT=production
SEMANTICUI_SNOWFLAKE_ACCOUNT=<org-account>
SEMANTICUI_OAUTH_CLIENT_ID=<idp-client-id>
# For the current server-side callback flow. Removed when the SPA
# public-client flow (plan S2) lands:
SEMANTICUI_OAUTH_CLIENT_SECRET=<confidential-client-secret-if-used>
```

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

## 5. Revocation (the kill switch)

Per user, at the Snowflake side — works even if the app is compromised:

```sql
ALTER USER <login_name> REMOVE DELEGATED AUTHORIZATIONS
  FROM SECURITY INTEGRATION semanticui_external_oauth;
```

Disable the whole path: `ALTER SECURITY INTEGRATION ... SET ENABLED = FALSE;`
