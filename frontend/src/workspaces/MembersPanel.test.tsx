import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMember } from "../api/types";
import MembersPanel from "./MembersPanel";

const MEMBERS: WorkspaceMember[] = [
  { userId: "u0", snowflakeUser: "ALICE", role: "admin", isMe: true },
  { userId: "u1", snowflakeUser: "BOB", role: "viewer", isMe: false },
];

let fetchMock: ReturnType<typeof vi.fn>;

function stub(members: WorkspaceMember[]) {
  const text = JSON.stringify({ members });
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
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

beforeEach(() => stub(MEMBERS));
afterEach(() => vi.unstubAllGlobals());

describe("MembersPanel", () => {
  it("lists members and marks which one is me", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    expect(await screen.findByText("ALICE")).toBeInTheDocument();
    expect(screen.getByText("BOB")).toBeInTheDocument();
    // The marker is a badge beside the name now, not a parenthetical.
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("lets an admin add a member by Snowflake username", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    await userEvent.type(await screen.findByLabelText(/snowflake username/i), "CAROL");
    await userEvent.selectOptions(
      within(screen.getByRole("form", { name: /add someone/i })).getByLabelText(
        /^role$/i,
      ),
      "editor",
    );
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post![0]).toBe("/api/workspaces/w1/members");
    expect(JSON.parse(post![1].body)).toEqual({
      snowflakeUser: "CAROL",
      role: "editor",
    });
  });

  it("shows a non-admin the list with no way to change it", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="viewer" onClose={() => {}} />);
    expect(await screen.findByText("ALICE")).toBeInTheDocument();
    expect(screen.queryByLabelText(/snowflake username/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /remove BOB/i })).toBeNull();
    expect(screen.getByText(/only an admin/i)).toBeInTheDocument();
  });

  it("disables the last admin's controls and says why", async () => {
    stub([{ userId: "u0", snowflakeUser: "ALICE", role: "admin", isMe: true }]);
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: /remove ALICE/i })).toBeDisabled();
    expect(screen.getByLabelText(/role for ALICE/i)).toBeDisabled();
    // The reason is attached to the controls it disables rather than left
    // as a line of prose the reader has to connect to them.
    expect(screen.getByRole("button", { name: /remove ALICE/i })).toHaveAttribute(
      "title",
      expect.stringMatching(/last admin cannot be removed or demoted/i),
    );
  });

  it("does not disable an admin's controls when there are two", async () => {
    stub([
      { userId: "u0", snowflakeUser: "ALICE", role: "admin", isMe: true },
      { userId: "u1", snowflakeUser: "BOB", role: "admin", isMe: false },
    ]);
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: /remove ALICE/i })).toBeEnabled();
  });

  it("changes a role", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    await userEvent.selectOptions(
      await screen.findByLabelText(/role for BOB/i),
      "editor",
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch![0]).toBe("/api/workspaces/w1/members/u1");
    expect(JSON.parse(patch![1].body)).toEqual({ role: "editor" });
  });

  it("confirms before removing a member, in the row it is about", async () => {
    // Removing somebody from a workspace takes away everything they could
    // read in it. Asked in the row rather than in a dialog that would have
    // to name them again.
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /remove BOB/i }));
    expect(
      fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE"),
    ).toBeUndefined();

    const confirm = screen.getByRole("group", { name: /confirm remove/i });
    await userEvent.click(within(confirm).getByRole("button", { name: /^remove$/i }));
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(del![0]).toBe("/api/workspaces/w1/members/u1");
  });

  it("backs out of a remove without doing it", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /remove BOB/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("group", { name: /confirm remove/i })).toBeNull();
    expect(
      fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE"),
    ).toBeUndefined();
  });

  it("surfaces a rejected add rather than failing silently", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    await screen.findByText("ALICE");
    const body = JSON.stringify({
      code: "REPORT_INVALID",
      message: "BOB is already a member.",
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => body,
      json: async () => JSON.parse(body),
    });
    await userEvent.type(screen.getByLabelText(/snowflake username/i), "BOB");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already a member/i);
  });

  it("says plainly that membership does not grant data access", async () => {
    // The single most important thing a person adding a colleague needs to
    // understand about this product.
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    expect(
      await screen.findByText(/their own\s+Snowflake credentials/i),
    ).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={onClose} />);
    await userEvent.click(await screen.findByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
