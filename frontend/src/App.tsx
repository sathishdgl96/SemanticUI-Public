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
import DashboardListPage from "./dashboards/DashboardListPage";
import DashboardPage from "./dashboards/DashboardPage";
import BuilderPage from "./reports/BuilderPage";
import ReportListPage from "./reports/ReportListPage";

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
                  <ReportListPage />
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
          <Route
            path="/dashboards"
            element={
              <RequireAuth>
                <AppShell>
                  <DashboardListPage />
                </AppShell>
              </RequireAuth>
            }
          />
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
