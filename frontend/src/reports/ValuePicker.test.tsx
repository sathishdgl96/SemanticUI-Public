import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "../api/client";
import ValuePicker from "./ValuePicker";

const apiFetchMock = vi.mocked(apiFetch);
const VIEW = { database: "DB", schema: "SCH", name: "V" };

/** The last values request, parsed. */
function lastValuesCall() {
  const call = [...apiFetchMock.mock.calls]
    .reverse()
    .find(([p]) => String(p).includes("/values?"));
  return call ? new URL(String(call[0]), "http://x").searchParams : null;
}

function answer(values: string[], truncated = false) {
  apiFetchMock.mockImplementation((...args: unknown[]) => {
    const url = new URL(String(args[0]), "http://x");
    const search = (url.searchParams.get("search") ?? "").toUpperCase();
    // The server narrows before it limits; the fake does the same so a test
    // about searching is not secretly a test about slicing a fetched page.
    const matched = search
      ? values.filter((v) => v.toUpperCase().includes(search))
      : values;
    const limit = Number(url.searchParams.get("limit") ?? 10);
    return Promise.resolve({
      values: matched.slice(0, limit),
      truncated: truncated || matched.length > limit,
    });
  });
}

function renderPicker(props: Partial<React.ComponentProps<typeof ValuePicker>> = {}) {
  const onChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ValuePicker
        view={VIEW}
        field="CUSTOMERS.REGION"
        selected={[]}
        onChange={onChange}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("ValuePicker", () => {
  it("asks for one screenful, not the whole column", async () => {
    answer(Array.from({ length: 40 }, (_, i) => `V${i}`));
    renderPicker();

    await screen.findByLabelText("V0");
    expect(lastValuesCall()?.get("limit")).toBe("10");
    expect(screen.getAllByRole("checkbox")).toHaveLength(10);
    // And says so, rather than implying the field has ten values.
    expect(await screen.findByText(/more values match/i)).toBeInTheDocument();
  });

  it("sends the search to the server instead of filtering what it has", async () => {
    // The distinction that matters: with 150 000 values, the one you want is
    // not in the page, so a client-side filter could never find it.
    answer(["NORTH", "SOUTH", "EAST", "WEST"]);
    renderPicker();
    await screen.findByLabelText("NORTH");

    await userEvent.type(screen.getByRole("searchbox"), "sou");

    await waitFor(() => expect(lastValuesCall()?.get("search")).toBe("sou"));
    expect(await screen.findByLabelText("SOUTH")).toBeInTheDocument();
  });

  it("debounces, so a word typed is one query and not one per letter", async () => {
    answer(["NORTH", "SOUTH"]);
    renderPicker();
    await screen.findByLabelText("NORTH");
    const before = apiFetchMock.mock.calls.length;

    await userEvent.type(screen.getByRole("searchbox"), "south");

    await waitFor(() => expect(lastValuesCall()?.get("search")).toBe("south"));
    // One more request for the settled term -- not five.
    expect(apiFetchMock.mock.calls.length - before).toBeLessThan(5);
  });

  it("keeps chosen values on screen when a search hides them", async () => {
    // Searching replaces the option list. Without a separate list of what is
    // already ticked, typing would look like it had discarded the selection.
    answer(["NORTH", "SOUTH"]);
    renderPicker({ selected: ["NORTH"] });
    await screen.findByLabelText("SOUTH");

    await userEvent.type(screen.getByRole("searchbox"), "sou");
    await waitFor(() => expect(lastValuesCall()?.get("search")).toBe("sou"));

    expect(screen.queryByLabelText("NORTH")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove NORTH" })).toBeInTheDocument();
  });

  it("removes a chosen value from its chip", async () => {
    answer(["NORTH", "SOUTH"]);
    const { onChange } = renderPicker({ selected: ["NORTH", "SOUTH"] });

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove NORTH" }),
    );
    expect(onChange).toHaveBeenCalledWith(["SOUTH"]);
  });

  it("adds and removes by ticking", async () => {
    answer(["NORTH", "SOUTH"]);
    const { onChange } = renderPicker({ selected: ["NORTH"] });

    await userEvent.click(await screen.findByLabelText("SOUTH"));
    expect(onChange).toHaveBeenCalledWith(["NORTH", "SOUTH"]);
  });

  it("replaces rather than accumulates when single-select", async () => {
    answer(["NORTH", "SOUTH"]);
    const { onChange } = renderPicker({
      selected: ["NORTH"],
      multi: false,
      groupName: "slicer-1",
    });

    await userEvent.click(await screen.findByLabelText("SOUTH"));
    expect(onChange).toHaveBeenCalledWith(["SOUTH"]);
  });

  it("says when nothing matches, distinctly from an empty field", async () => {
    answer(["NORTH"]);
    renderPicker();
    await screen.findByLabelText("NORTH");

    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(await screen.findByText(/no values match "zzz"/i)).toBeInTheDocument();
  });
});
