import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import type { Config } from "../api/types";

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => apiFetch<Config>("/api/config"),
  });
  const [account, setAccount] = useState("");
  const [user, setUser] = useState("");
  const [authenticator, setAuthenticator] = useState<"externalbrowser" | "password">(
    "externalbrowser",
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (config.isLoading) return <p>Loading...</p>;
  if (config.isError || !config.data) return <p>Cannot reach the backend.</p>;

  if (config.data.authMode === "oauth") {
    return (
      <main className="login">
        <h1>SemanticUI</h1>
        <a className="button" href="/auth/login">
          Sign in with Snowflake
        </a>
      </main>
    );
  }

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
        }),
      });
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
      <p>Dev mode: sign in with your own Snowflake credentials.</p>
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
            onChange={(e) =>
              setAuthenticator(e.target.value as "externalbrowser" | "password")
            }
          >
            <option value="externalbrowser">External browser (SSO)</option>
            <option value="password">Password</option>
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
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
