import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { setOnAuthExpired } from "./api/client";
import LoginPage from "./auth/LoginPage";
import { useMe } from "./auth/useMe";
import AppShell from "./shell/AppShell";
import ExplorerPage from "./explorer/ExplorerPage";
import HomePage from "./home/HomePage";
import AdminPage from "./admin/AdminPage";
import DashboardPage from "./dashboards/DashboardPage";
import WorkspacePage from "./workspaces/WorkspacePage";
import BuilderPage from "./reports/BuilderPage";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <p>Loading...</p>;
  if (me.isError) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AuthExpiredBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setOnAuthExpired((reason?: string) =>
      navigate("/login", { state: reason ? { reason } : undefined }),
    );
    return () => setOnAuthExpired(null);
  }, [navigate]);
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthExpiredBridge />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <AppShell>
                  <HomePage />
                </AppShell>
              </RequireAuth>
            }
          />
          <Route
            path="/reports"
            element={
              <RequireAuth>
                <AppShell>
                  <WorkspacePage />
                </AppShell>
              </RequireAuth>
            }
          />
          <Route
            path="/explore"
            element={
              <RequireAuth>
                <AppShell>
                  <ExplorerPage />
                </AppShell>
              </RequireAuth>
            }
          />
          {/* One browse page. The old per-kind route lands on it rather
              than 404ing a link somebody already has. */}
          <Route path="/dashboards" element={<Navigate to="/reports" replace />} />
          <Route
            path="/dashboards/:id"
            element={
              <RequireAuth>
                <AppShell>
                  <DashboardPage />
                </AppShell>
              </RequireAuth>
            }
          />
          {/* A splat: the admin area routes its own tabs, so the three
              of them are one entry here rather than three. */}
          <Route
            path="/admin/*"
            element={
              <RequireAuth>
                <AppShell>
                  <AdminPage />
                </AppShell>
              </RequireAuth>
            }
          />
          <Route
            path="/reports/:id"
            element={
              <RequireAuth>
                <AppShell>
                  <BuilderPage />
                </AppShell>
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
