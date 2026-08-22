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
import ErrorBoundary from "./ui/ErrorBoundary";
import LoadingScreen from "./ui/LoadingScreen";
import NotFoundPage from "./ui/NotFoundPage";
import RouteSuspense from "./ui/RouteSuspense";
// Lazy, and for a measurable reason: these six pages are what drag in
// echarts, @xyflow/react, dagre and react-grid-layout. Imported eagerly they
// rode along in the first download even for somebody still looking at the
// sign-in form. LoginPage and AppShell stay eager -- they ARE the first
// paint, and a chunk request for them would only add a round-trip.
//
// They live in ./routes because the nav rail warms them on hover and cannot
// import pages it does not render.
import {
  AdminPage,
  BuilderPage,
  DashboardPage,
  ExplorerPage,
  HomePage,
  ModelPage,
  WorkspacePage,
} from "./routes";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <LoadingScreen label="Signing you in…" page />;
  if (me.isError) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Every signed-in route is the same three layers, so they are written once.
 *
 *  The boundary sits INSIDE AppShell deliberately: a route's chunk arriving
 *  late should leave the topbar and nav rail standing and show the wait in
 *  the content area, not blank the whole window and rebuild it a moment
 *  later.
 *
 *  `id` is per route and not per URL -- see RouteSuspense for why it has to
 *  be keyed at all, and why /reports/1 -> /reports/2 must keep the same one. */
function Shell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>
        <RouteSuspense routeId={id}>{children}</RouteSuspense>
      </AppShell>
    </RequireAuth>
  );
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
    // Outermost, so a throw in a provider or in the router itself still
    // lands somewhere. It uses no router of its own for exactly this reason.
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthExpiredBridge />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<Shell id="home"><HomePage /></Shell>} />
            <Route path="/reports" element={<Shell id="reports"><WorkspacePage /></Shell>} />
            <Route path="/explore" element={<Shell id="explore"><ExplorerPage /></Shell>} />
            {/* One browse page. The old per-kind route lands on it rather
                than 404ing a link somebody already has. */}
            <Route path="/dashboards" element={<Navigate to="/reports" replace />} />
            <Route path="/dashboards/:id" element={<Shell id="dashboard"><DashboardPage /></Shell>} />
            {/* A splat: the admin area routes its own tabs, so the three
                of them are one entry here rather than three. */}
            <Route path="/admin/*" element={<Shell id="admin"><AdminPage /></Shell>} />
            <Route path="/models/:id" element={<Shell id="model"><ModelPage /></Shell>} />
            <Route path="/reports/:id" element={<Shell id="builder"><BuilderPage /></Shell>} />
            {/* Last, and it must exist: the server answers any unmatched
                deep link with the shell page (SpaStaticFiles in
                app/main.py), so without this a typo'd URL rendered nothing
                at all. Behind RequireAuth like everything else, which also
                means a stranger cannot map our routes by guessing. */}
            <Route path="*" element={<Shell id="notfound"><NotFoundPage /></Shell>} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
