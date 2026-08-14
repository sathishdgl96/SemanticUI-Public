import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import type { Config } from "../api/types";

type Authenticator = "externalbrowser" | "password" | "keypair";

const AUTHENTICATOR_LABELS: Record<Authenticator, string> = {
  externalbrowser: "External browser (SSO)",
  password: "Password",
  keypair: "Key pair (PEM)",
};

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => apiFetch<Config>("/api/config"),
  });
  const [account, setAccount] = useState("");
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
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>SemanticUI</h1>
      {authMode === "oauth" && (
        <a className="button" href="/auth/login">
          Sign in with Snowflake
        </a>
      )}
      {directLoginMethods.length > 0 && (
        <>
          <p>Sign in with your own Snowflake credentials.</p>
          <form onSubmit={submit}>
            <label>
              Account
              <input value={account} onChange={(e) => setAccount(e.target.value)} required />
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
