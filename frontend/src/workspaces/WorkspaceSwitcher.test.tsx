import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../api/types";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

const WORKSPACES: WorkspaceSummary[] = [
  {
    id: "w0",
    name: "My reports",
    kind: "personal",
    myRole: "admin",
    memberCount: 1,
    reportCount: 2,
  },
  {
    id: "w1",
    name: "Team",
    kind: "shared",
    myRole: "viewer",
    memberCount: 4,
    reportCount: 7,
  },
];

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

let fetchMock: ReturnType<typeof vi.fn>;

function stub(body: unknown) {
  const text = JSON.stringify(body);
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
    json: async () => JSON.parse(text),
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => stub({ workspaces: WORKSPACES }));
afterEach(() => vi.unstubAllGlobals());

const props = {
  value: "w0",
  onChange: () => {},
  onCreated: () => {},
  onManageMembers: () => {},
};

describe("WorkspaceSwitcher", () => {
  it("lists every workspace I belong to", async () => {
    wrap(<WorkspaceSwitcher {...props} />);
    // Waited on an OPTION, not the label: the select renders on the first
    // pass with no options at all, so findByLabelText resolves before the
    // workspaces have arrived and the assertion sees an empty list.
    await screen.findByRole("option", { name: "Team" });
    const select = screen.getByLabelText(/^workspace$/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "My reports",
      "Team",
    ]);
  });

  it("reports a change", async () => {
    const onChange = vi.fn();
    wrap(<WorkspaceSwitcher {...props} onChange={onChange} />);
    await screen.findByRole("option", { name: "Team" });
    await userEvent.selectOptions(screen.getByLabelText(/^workspace$/i), "w1");
    expect(onChange).toHaveBeenCalledWith("w1");
  });

  it("states my role in the selected workspace", async () => {
    wrap(<WorkspaceSwitcher {...props} value="w1" />);
    expect(await screen.findByText(/you are a viewer here/i)).toBeInTheDocument();
  });

  it("offers Members for a shared workspace, with the count", async () => {
    const onManageMembers = vi.fn();
    wrap(
      <WorkspaceSwitcher {...props} value="w1" onManageMembers={onManageMembers} />,
    );
    const button = await screen.findByRole("button", { name: /members \(4\)/i });
    await userEvent.click(button);
    expect(onManageMembers).toHaveBeenCalled();
  });

  it("does not offer Members for a personal workspace", async () => {
    // Absent rather than disabled: a disabled button implies there is
    // something to reveal, and a personal workspace has no membership at all.
    wrap(<WorkspaceSwitcher {...props} value="w0" />);
    await screen.findByLabelText(/^workspace$/i);
    expect(screen.queryByRole("button", { name: /members/i })).toBeNull();
  });

  it("creates a workspace and reports the new id", async () => {
    wrap(<WorkspaceSwitcher {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /new workspace/i }));
    await userEvent.type(screen.getByLabelText(/workspace name/i), "Finance");

    stub({ id: "w2", name: "Finance", kind: "shared", myRole: "admin" });
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await screen.findByLabelText(/^workspace$/i);

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post![0]).toBe("/api/workspaces");
    expect(JSON.parse(post![1].body)).toEqual({ name: "Finance" });
  });

  it("will not submit an empty workspace name", async () => {
    wrap(<WorkspaceSwitcher {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /new workspace/i }));
    expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();
  });

  it("can be cancelled", async () => {
    wrap(<WorkspaceSwitcher {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /new workspace/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByLabelText(/workspace name/i)).toBeNull();
  });

  it("surfaces a rejected creation rather than failing silently", async () => {
    wrap(<WorkspaceSwitcher {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /new workspace/i }));
    await userEvent.type(screen.getByLabelText(/workspace name/i), "Team");

    const body = JSON.stringify({
      code: "REPORT_INVALID",
      message: "That name is already taken.",
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => body,
      json: async () => JSON.parse(body),
    });
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already taken/i);
  });
});
