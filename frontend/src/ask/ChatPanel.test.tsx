import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "./ChatPanel";

function answerFor(explanation: string) {
  return {
    explanation,
    spec: {
      dimensions: ["CUSTOMERS.REGION"],
      metrics: ["ORDERS.TOTAL_REVENUE"],
      filters: [],
      orderBy: [],
      limit: 20,
      explanation,
    },
    columns: [
      { name: "REGION", type: "TEXT" },
      { name: "TOTAL_REVENUE", type: "FIXED" },
    ],
    rows: [["EAST", 100]],
    truncated: false,
    sql: "SELECT * FROM SEMANTIC_VIEW(...)",
  };
}

const ANSWER = answerFor("Revenue by region.");

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

/** Answers a different explanation per call, so a conversation can be told
 *  apart from one answer rendered twice. */
function stubSequence(explanations: string[]) {
  let call = 0;
  fetchMock = vi.fn().mockImplementation(() => {
    const text = JSON.stringify(answerFor(explanations[Math.min(call++, explanations.length - 1)]));
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => text,
      json: async () => JSON.parse(text),
    });
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

const box = () => screen.getByRole("textbox", { name: "Message" });

async function send(text: string) {
  await userEvent.type(box(), text);
  await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
}

function bodyOf(call: number) {
  return JSON.parse(fetchMock.mock.calls[call][1].body);
}

describe("ChatPanel", () => {
  it("sends the question and shows the explanation", async () => {
    wrap(<ChatPanel {...props} />);
    await send("revenue by region?");
    expect(await screen.findByText("Revenue by region.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/reports/r1/ask");
    expect(bodyOf(0)).toEqual({ question: "revenue by region?", history: [] });
  });

  it("keeps the conversation on screen and sends it with the next question", async () => {
    // This is the whole difference from a one-shot box: "now split that by
    // segment" is not a question anyone can answer without the turn before it.
    stubSequence(["Revenue by region.", "Revenue by region and segment."]);
    wrap(<ChatPanel {...props} />);
    await send("revenue by region?");
    await screen.findByText("Revenue by region.");
    await send("now split that by segment");

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    expect(bodyOf(1)).toEqual({
      question: "now split that by segment",
      history: [
        { question: "revenue by region?", answer: "Revenue by region." },
      ],
    });
    // Both turns stay readable; a chat that replaces its last answer is a
    // question box with bubbles.
    expect(screen.getByText("revenue by region?")).toBeInTheDocument();
    expect(await screen.findByText("Revenue by region and segment.")).toBeInTheDocument();
  });

  it("sends the model its own words, never the rows that came back", async () => {
    // The no-data-in-the-prompt rule is what makes this safe to point at a
    // governed model. A conversation is where it would be easiest to lose.
    stubSequence(["Revenue by region.", "And by segment."]);
    wrap(<ChatPanel {...props} />);
    await send("revenue?");
    await screen.findByText("Revenue by region.");
    await send("and by segment?");

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    expect(JSON.stringify(bodyOf(1))).not.toContain("EAST");
    expect(JSON.stringify(bodyOf(1))).not.toContain("100");
  });

  it("does not carry an unanswered question into the history", async () => {
    // It would tell the model a thing was asked and leave it guessing what
    // came of it.
    stub({ code: "CORTEX_UNAVAILABLE", message: "nope" }, 503);
    wrap(<ChatPanel {...props} />);
    await send("first");
    await screen.findByRole("alert");
    await send("second");
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    expect(bodyOf(1).history).toEqual([]);
  });

  it("renders the answer's rows", async () => {
    wrap(<ChatPanel {...props} />);
    await send("q");
    expect(await screen.findByText("EAST")).toBeInTheDocument();
  });

  it("shows what the model asked for, and the SQL, on request", async () => {
    // An answer you cannot audit is an answer you should not act on -- but it
    // does not need to be the loudest thing in the bubble.
    wrap(<ChatPanel {...props} />);
    await send("q");
    await screen.findByText("Revenue by region.");
    await userEvent.click(screen.getByText(/how this was answered/i));
    expect(screen.getByText(/CUSTOMERS.REGION/)).toBeInTheDocument();
    expect(screen.getByText(/SEMANTIC_VIEW/)).toBeInTheDocument();
  });

  it("will not send an empty message", () => {
    wrap(<ChatPanel {...props} />);
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();
  });

  it("explains an unavailable Cortex rather than showing a generic failure", async () => {
    stub(
      {
        code: "CORTEX_UNAVAILABLE",
        message:
          "Snowflake Cortex is not available on this account: AI function " +
          "COMPLETE is not available for trial accounts.",
      },
      503,
    );
    wrap(<ChatPanel {...props} />);
    await send("q");
    expect(await screen.findByRole("alert")).toHaveTextContent(/trial accounts/i);
  });

  it("keeps the box usable after a failure, and keeps the failed turn visible", async () => {
    stub({ code: "CORTEX_UNAVAILABLE", message: "nope" }, 503);
    wrap(<ChatPanel {...props} />);
    await send("q");
    await screen.findByRole("alert");
    expect(box()).toBeEnabled();
    // The question stays, so it can be read and rephrased rather than retyped.
    expect(screen.getByText("q")).toBeInTheDocument();
  });

  it("names the field the model got wrong, so the question can be rephrased", async () => {
    stub(
      {
        code: "ASK_INVALID",
        message: "The model asked for ORDERS.PROFIT, which is not a metric.",
      },
      400,
    );
    wrap(<ChatPanel {...props} />);
    await send("profit?");
    expect(await screen.findByRole("alert")).toHaveTextContent(/ORDERS.PROFIT/);
  });

  it("builds the report: any answer can become a visual", async () => {
    const onAddVisual = vi.fn();
    wrap(<ChatPanel {...props} onAddVisual={onAddVisual} />);
    await send("q");
    await userEvent.click(await screen.findByRole("button", { name: /add to report/i }));
    expect(onAddVisual).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: ["ORDERS.TOTAL_REVENUE"] }),
    );
  });

  it("does not offer that to a viewer", async () => {
    wrap(<ChatPanel {...props} canEdit={false} />);
    await send("q");
    await screen.findByText("Revenue by region.");
    expect(screen.queryByRole("button", { name: /add to report/i })).toBeNull();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    wrap(<ChatPanel {...props} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
