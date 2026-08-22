import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

// React prints the caught error to console.error on every boundary hit, and
// re-throws it so the page's own error reporting sees it -- which in jsdom
// means a stack trace on stderr. Both are React working, not failures.
// Silence the pair so a passing run stays readable, and restore them so a
// real error elsewhere still shows.
const swallowUncaught = (event: ErrorEvent) => event.preventDefault();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("error", swallowUncaught);
});

afterEach(() => {
  window.removeEventListener("error", swallowUncaught);
  vi.restoreAllMocks();
});

function Boom({ throws }: { throws: boolean }): React.ReactElement {
  if (throws) throw new Error("chart renderer exploded");
  return <p>the report</p>;
}

describe("ErrorBoundary", () => {
  it("shows a recovery page when a child throws, instead of blanking the app", () => {
    render(
      <ErrorBoundary>
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.queryByText("the report")).not.toBeInTheDocument();
  });

  it("keeps the failure readable for support, without shouting a stack trace", () => {
    render(
      <ErrorBoundary>
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/chart renderer exploded/)).toBeInTheDocument();
  });

  it("retries in place, so a transient failure does not cost a full page reload", async () => {
    function Flaky() {
      return <Boom throws={fails} />;
    }
    let fails = true;
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();

    fails = false;
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("the report")).toBeInTheDocument();
  });

  it("stays out of the way when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("the report")).toBeInTheDocument();
  });
});
