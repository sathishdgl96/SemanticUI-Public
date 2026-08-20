import { useBranding } from "../shell/useBranding";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import type { Config } from "../api/types";
import { AccountPicker } from "./AccountPicker";

type Authenticator = "externalbrowser" | "password" | "keypair";

const AUTHENTICATOR_LABELS: Record<Authenticator, string> = {
  externalbrowser: "External browser (SSO)",
  password: "Password",
  keypair: "Key pair (PEM)",
};

export default function LoginPage() {
  const branding = useBranding();
  const navigate = useNavigate();
  // Set when an expired session bounced the user here, so the page can explain
  // the redirect instead of looking like the session vanished on its own.
  const redirectReason = (useLocation().state as { reason?: string } | null)?.reason;
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => apiFetch<Config>("/api/config"),
  });
  const [account, setAccount] = useState("");
  // Separate from `account` above, which is typed into the dev-login
  // form: this one is chosen from the configured list for SSO.
  const [ssoAccount, setSsoAccount] = useState("");
  const [user, setUser] = useState("");
  const [authenticator, setAuthenticator] = useState<Authenticator>("externalbrowser");
  const [password, setPassword] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (config.isLoading) return <p>Loading...</p>;
  if (config.isError || !config.data) return <p>Cannot reach the backend.</p>;

  const { authMode, directLoginMethods } = config.data;
  const accounts = config.data.accounts ?? [];
  const chosenAccount = ssoAccount || accounts[0]?.account || "";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/auth/dev-login", {
        method: "POST",
        body: JSON.stringify({
          account,
          user,
          authenticator,
          password: authenticator === "password" ? password : null,
          ...(authenticator === "keypair"
            ? {
                private_key_pem: privateKeyPem,
                private_key_passphrase: privateKeyPassphrase || null,
              }
            : {}),
        }),
      });
      // Drop key material from memory now that the connection is established.
      setPrivateKeyPem("");
      setPrivateKeyPassphrase("");
      // A full clear, not just an invalidation of ["me"]: this browser may
      // still hold another identity's cached semantic-views/semantic-view
      // data from a previous session, which must never be shown to whoever
      // just signed in.
      queryClient.clear();
      navigate("/");
    } catch (err) {
      // Snowflake's own explanation arrives in `detail`; without it the user
      // sees only "Snowflake login failed" and cannot tell a wrong password
      // from an MFA policy or a malformed account identifier. The backend
      // already withholds `detail` on the keypair path, so showing it here
      // cannot surface key material.
      const message =
        err instanceof ApiError
          ? [err.message, err.detail].filter(Boolean).join(" ")
          : "Login failed";
      setError(
        authenticator === "keypair"
          ? `${message} Re-paste your private key to try again.`
          : message,
      );
      // Never leave key material sitting in an unmasked textarea after a
      // failed login attempt.
      setPrivateKeyPem("");
      setPrivateKeyPassphrase("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>
        {branding.logoUrl ? (
          <img
              className="brand-logo"
              src={branding.logoUrl}
              alt=""
              onError={(e) => {
                // A dead logo URL must not render as a broken-image icon;
                // hiding it leaves the name to carry the brand.
                e.currentTarget.style.display = "none";
              }}
            />
        ) : (
          <span className="brand-mark" aria-hidden="true" />
        )}
        {branding.name}
      </h1>
      {redirectReason && <p className="notice">{redirectReason}</p>}
      {authMode === "oauth" && (
        <div className="sso-signin">
          <AccountPicker
            accounts={accounts}
            value={chosenAccount}
            onChange={setSsoAccount}
          />
          <a
            className="button"
            href={
              chosenAccount
                ? `/auth/login?account=${encodeURIComponent(chosenAccount)}`
                : "/auth/login"
            }
          >
            Sign in with Snowflake
          </a>
        </div>
      )}
      {/* Single sign-on is the way in. The direct-credential form below is
          offered only where a deployment named a method explicitly, or in
          dev auth mode, which exists to have a way in without an IdP --
          see Settings.login_methods(). */}
      {directLoginMethods.length > 0 && (
        <>
          <p className="login-alternative">
            Or sign in with your own Snowflake credentials.
          </p>
          <form onSubmit={submit}>
            <label>
              Account
              <input
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="myorg-myaccount"
                required
              />
              <small className="field-note">
                Organization and account joined by a hyphen — the two path segments in
                your Snowflake URL, not the full hostname.
              </small>
            </label>
            <label>
              User
              <input value={user} onChange={(e) => setUser(e.target.value)} required />
            </label>
            <label>
              Authenticator
              <select
                value={authenticator}
                onChange={(e) => setAuthenticator(e.target.value as Authenticator)}
              >
                {directLoginMethods.map((method) => (
                  <option key={method} value={method}>
                    {AUTHENTICATOR_LABELS[method]}
                  </option>
                ))}
              </select>
            </label>
            {authenticator === "password" && (
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            )}
            {authenticator === "keypair" && (
              <>
                <label>
                  Private key (PEM)
                  <textarea
                    value={privateKeyPem}
                    onChange={(e) => setPrivateKeyPem(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    autoCorrect="off"
                    required
                  />
                </label>
                <label>
                  Key passphrase (optional)
                  <input
                    type="password"
                    value={privateKeyPassphrase}
                    onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                  />
                </label>
              </>
            )}
            {error && <p role="alert">{error}</p>}
            <button type="submit" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
