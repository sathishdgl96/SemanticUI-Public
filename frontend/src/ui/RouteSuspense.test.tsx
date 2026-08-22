import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import RouteSuspense from "./RouteSuspense";

// A chunk whose arrival this test controls, standing in for the real
// network fetch a lazy route makes.
let land: () => void;
const Workspace = lazy(
  () =>
    new Promise<{ default: () => React.ReactElement }>((resolve) => {
      land = () => resolve({ default: () => <p>workspace page</p> });
    }),
);

function Explore() {
  return <p>explore pane</p>;
}

// Mirrors App.tsx: ONE shell component reused across every route, so the
// boundary inside it is already mounted and holding the old page when the
// next one suspends. That reuse is the whole point of the test.
function Shell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div>
      <Link to="/reports">go to workspace</Link>
      <RouteSuspense routeId={id}>{children}</RouteSuspense>
    </div>
  );
}

function navigateFromExploreToWorkspace() {
  render(
    <MemoryRouter initialEntries={["/explore"]}>
      <Routes>
        <Route path="/explore" element={<Shell id="explore"><Explore /></Shell>} />
        <Route path="/reports" element={<Shell id="reports"><Workspace /></Shell>} />
      </Routes>
    </MemoryRouter>,
  );
  return userEvent.click(screen.getByRole("link", { name: /go to workspace/i }));
}

describe("RouteSuspense", () => {
  it("drops the page being left, rather than leaving it up while the next chunk downloads", async () => {
    // React Router runs navigation inside startTransition, and React's rule
    // for a transition is to keep already-visible content on screen rather
    // than flash a fallback. Shared across routes, one boundary therefore
    // left the Explore pane sitting there for the whole download -- looking
    // like the click had not registered.
    await navigateFromExploreToWorkspace();

    expect(screen.queryByText("explore pane")).not.toBeInTheDocument();
  });

  it("says it is loading while the chunk is in flight", async () => {
    await navigateFromExploreToWorkspace();

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("shows the page once its chunk lands", async () => {
    await navigateFromExploreToWorkspace();
    land();

    expect(await screen.findByText("workspace page")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
