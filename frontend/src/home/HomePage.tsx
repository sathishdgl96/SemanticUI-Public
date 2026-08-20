import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import { getHome, rearrangeWidgets, unpinWidget } from "../api/home";
import RecentItems from "./RecentItems";
import WidgetGrid from "./WidgetGrid";

/**
 * Home: what you were last working on, and what you chose to keep in view.
 *
 * Both halves arrive in one request. The page has nothing to show without
 * each of them, and two round trips would only stagger the arrival.
 */
export default function HomePage() {
  const queryClient = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: getHome });

  const remove = useMutation({
    mutationFn: (widgetId: string) => unpinWidget(widgetId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["home"] }),
  });

  const rearrange = useMutation({
    mutationFn: rearrangeWidgets,
    // Deliberately NOT invalidating: the grid already shows the new
    // arrangement, and refetching would drop every tile's query and make
    // the whole page flash on a drag that changed nothing but position.
  });

  const recent = home.data?.recent ?? [];
  const widgets = home.data?.widgets ?? [];

  return (
    <main className="home">
      <header className="home-head">
        <h1 className="page-title">Home</h1>
        <Link className="button secondary" to="/reports">
          All reports
        </Link>
      </header>

      {home.isError && (
        <p role="alert">
          {home.error instanceof ApiError
            ? home.error.message
            : "Could not load your home page."}
        </p>
      )}

      <section className="home-section" aria-labelledby="home-recent">
        <h2 className="home-section-title" id="home-recent">
          Recent
        </h2>
        {home.isLoading ? (
          <p className="tile-hint">Loading…</p>
        ) : (
          <RecentItems items={recent} />
        )}
      </section>

      <section className="home-section" aria-labelledby="home-pinned">
        <h2 className="home-section-title" id="home-pinned">
          Pinned
        </h2>
        {!home.isLoading && (
          <WidgetGrid
            widgets={widgets}
            onRemove={(id) => remove.mutate(id)}
            onRearrange={(layouts) => rearrange.mutate(layouts)}
          />
        )}
      </section>
    </main>
  );
}
