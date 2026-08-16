import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AskPanel from "./AskPanel";

const ANSWER = {
  explanation: "Revenue by region.",
  spec: {
    dimensions: ["CUSTOMERS.REGION"],
    metrics: ["ORDERS.TOTAL_REVENUE"],
    filters: [],
    orderBy: [],
    limit: 20,
    explanation: "Revenue by region.",
  },
  columns: [
    { name: "REGION", type: "TEXT" },
    { name: "TOTAL_REVENUE", type: "FIXED" },
  ],
  rows: [["EAST", 100]],
  truncated: false,
  sql: "SELECT * FROM SEMANTIC_VIEW(...)",
};

let fetchMock: ReturnType<typeof vi.fn>;

function stub(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
    json: async () => JSON.parse(text),
  });
  vi.stubGlobal("fetch", fetchMock);
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const props = {
  reportId: "r1",
  canEdit: true,
  onAddVisual: () => {},
  onClose: () => {},
};

beforeEach(() => stub(ANSWER));
afterEach(() => vi.unstubAllGlobals());

/** Role-scoped rather than getByLabelText(/question/i): the panel's own
 *  `aria-label="Ask a question"` also matches that pattern, so the loose
 *  query finds the section as well as the input. */
const questionBox = () => screen.getByRole("textbox", { name: "Question" });

async function ask(question = "revenue by region?") {
  await userEvent.type(questionBox(), question);
  await userEvent.click(screen.getByRole("button", { name: /^ask$/i }));
}

describe("AskPanel", () => {
  it("sends the question and shows the explanation", async () => {
    wrap(<AskPanel {...props} />);
    await ask();
    expect(await screen.findByText("Revenue by region.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/r1/ask");
    expect(JSON.parse(init.body)).toEqual({ question: "revenue by region?" });
  });

  it("shows what the model actually asked for", async () => {
    // An answer you cannot audit is an answer you should not act on.
    wrap(<AskPanel {...props} />);
    await ask();
    expect(await screen.findByText(/CUSTOMERS.REGION/)).toBeInTheDocument();
    expect(screen.getByText(/ORDERS.TOTAL_REVENUE/)).toBeInTheDocument();
  });

  it("renders the answer's rows", async () => {
    wrap(<AskPanel {...props} />);
    await ask();
    expect(await screen.findByText("EAST")).toBeInTheDocument();
  });

  it("will not send an empty question", () => {
    wrap(<AskPanel {...props} />);
    expect(screen.getByRole("button", { name: /^ask$/i })).toBeDisabled();
  });

  it("explains an unavailable Cortex rather than showing a generic failure", async () => {
    // The state of the development account, so this is the path a user is
    // most likely to hit.
    stub(
      {
        code: "CORTEX_UNAVAILABLE",
        message:
          "Snowflake Cortex is not available on this account: AI function " +
          "COMPLETE is not available for trial accounts.",
      },
      503,
    );
    wrap(<AskPanel {...props} />);
    await ask("q");
    expect(await screen.findByRole("alert")).toHaveTextContent(/trial accounts/i);
  });

  it("keeps the question box usable after a failure", async () => {
    stub({ code: "CORTEX_UNAVAILABLE", message: "nope" }, 503);
    wrap(<AskPanel {...props} />);
    await ask("q");
    await screen.findByRole("alert");
    expect(questionBox()).toBeEnabled();
    expect(screen.getByRole("button", { name: /^ask$/i })).toBeEnabled();
  });

  it("names the field the model got wrong, so the question can be rephrased", async () => {
    stub(
      {
        code: "ASK_INVALID",
        message: "The model asked for ORDERS.PROFIT, which is not a metric.",
      },
      400,
    );
    wrap(<AskPanel {...props} />);
    await ask("profit?");
    expect(await screen.findByRole("alert")).toHaveTextContent(/ORDERS.PROFIT/);
  });

  it("offers Add as visual to an editor", async () => {
    const onAddVisual = vi.fn();
    wrap(<AskPanel {...props} onAddVisual={onAddVisual} />);
    await ask("q");
    await userEvent.click(await screen.findByRole("button", { name: /add as visual/i }));
    expect(onAddVisual).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: ["ORDERS.TOTAL_REVENUE"] }),
    );
  });

  it("does not offer Add as visual to a viewer", async () => {
    wrap(<AskPanel {...props} canEdit={false} />);
    await ask("q");
    await screen.findByText("Revenue by region.");
    expect(screen.queryByRole("button", { name: /add as visual/i })).toBeNull();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    wrap(<AskPanel {...props} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
