import { lazy } from "react";

/** Every route that is loaded on demand, in one place.
 *
 *  Two things need these and they are not in the same part of the tree: the
 *  router renders them, and the nav rail warms them on hover. Keeping the
 *  import() calls here is what lets the rail start a download for a page it
 *  does not itself import. */
const loaders = {
  home: () => import("./home/HomePage"),
  reports: () => import("./workspaces/WorkspacePage"),
  explore: () => import("./explorer/ExplorerPage"),
  dashboard: () => import("./dashboards/DashboardPage"),
  builder: () => import("./reports/BuilderPage"),
  admin: () => import("./admin/AdminPage"),
  model: () => import("./models/ModelPage"),
} as const;

export type RouteKey = keyof typeof loaders;

export const HomePage = lazy(loaders.home);
export const WorkspacePage = lazy(loaders.reports);
export const ExplorerPage = lazy(loaders.explore);
export const DashboardPage = lazy(loaders.dashboard);
export const BuilderPage = lazy(loaders.builder);
export const AdminPage = lazy(loaders.admin);
export const ModelPage = lazy(loaders.model);

/** Run a loader for its side effect and swallow the outcome.
 *
 *  Exported for its own sake so the swallowing is testable: a prefetch is
 *  speculative -- somebody moved a pointer -- and a chunk that fails to
 *  arrive must not become an unhandled rejection. The navigation that
 *  follows will ask again, and report properly through the error boundary
 *  if it still fails. */
export function warm(load: () => Promise<unknown>): Promise<void> {
  return load().then(
    () => undefined,
    () => undefined,
  );
}

/** Start a route's chunk downloading before it is needed.
 *
 *  Idempotent and cheap to repeat: import() is memoised by the module
 *  registry, so a pointer crossing the rail three times still fetches once.
 *  A hover typically buys 100-300ms of head start, which is most of a small
 *  chunk's download -- and a route already in memory never suspends, so the
 *  loading screen never appears at all. */
export function prefetchRoute(key: RouteKey): Promise<void> {
  return warm(loaders[key]);
}
