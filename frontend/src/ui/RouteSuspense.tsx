import { Suspense, type ReactNode } from "react";
import LoadingScreen from "./LoadingScreen";

interface RouteSuspenseProps {
  /** Stable per route, NOT per URL. Two ids must differ across routes so the
   *  boundary is rebuilt on a route change, and must match across a param
   *  change (/reports/1 -> /reports/2) so that page keeps its state. */
  routeId: string;
  children: ReactNode;
}

/** The boundary a lazy route waits behind.
 *
 *  `key` is the entire point. Every route renders through one shared shell,
 *  so without it there is a single boundary that is already mounted and
 *  holding the previous page when the next one suspends -- and React Router
 *  runs navigation inside startTransition, where React's rule is to keep
 *  visible content on screen rather than flash a fallback. The result was
 *  the page you just left sitting there for the whole download, looking for
 *  all the world like the click had not registered.
 *
 *  Keyed by route, a route change builds a NEW boundary. A boundary with no
 *  previous content has nothing to preserve, so it shows the fallback at
 *  once. Nothing flashes when the chunk is already in memory: React.lazy
 *  resolves a loaded module synchronously and never suspends, which is what
 *  the rail's hover prefetch (see src/routes.ts) is arranging for. */
export default function RouteSuspense({ routeId, children }: RouteSuspenseProps) {
  return (
    <Suspense key={routeId} fallback={<LoadingScreen />}>
      {children}
    </Suspense>
  );
}
