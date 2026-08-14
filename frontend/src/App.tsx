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
import ExplorerPage from "./explorer/ExplorerPage";

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
    setOnAuthExpired(() => navigate("/login"));
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
                <ExplorerPage />
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
