import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMember,
  atLeast,
  createWorkspace,
  deleteWorkspace,
  listMembers,
  listWorkspaces,
  moveReport,
  removeMember,
  renameWorkspace,
  setMemberRole,
} from "./workspaces";

let fetchMock: ReturnType<typeof vi.fn>;

function stub(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    // apiFetch reads text() first, for its empty-204-body guard; a stub with
    // only json() resolves to "response.text is not a function".
    text: async () => text,
    json: async () => JSON.parse(text),
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => stub({ workspaces: [] }));
afterEach(() => vi.unstubAllGlobals());

describe("atLeast", () => {
  it("orders viewer below editor below admin", () => {
    expect(atLeast("admin", "editor")).toBe(true);
    expect(atLeast("admin", "viewer")).toBe(true);
    expect(atLeast("editor", "viewer")).toBe(true);
  });

  it("does not let a lower role satisfy a higher requirement", () => {
    expect(atLeast("viewer", "editor")).toBe(false);
    expect(atLeast("editor", "admin")).toBe(false);
  });

  it("treats every role as satisfying itself", () => {
    expect(atLeast("viewer", "viewer")).toBe(true);
    expect(atLeast("editor", "editor")).toBe(true);
    expect(atLeast("admin", "admin")).toBe(true);
  });

  it("fails closed on an unrecognised role, matching the server", () => {
    // "superuser" > "admin" as a plain string comparison, which is exactly
    // the trap this mirrors the backend to avoid.
    expect(atLeast("superuser" as never, "viewer")).toBe(false);
    expect(atLeast("admin", "root" as never)).toBe(false);
  });
});

describe("workspace API", () => {
  it("lists workspaces", async () => {
    await listWorkspaces();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/workspaces");
  });

  it("creates a workspace", async () => {
    stub({ id: "w1", name: "Team" }, 201);
    await createWorkspace("Team");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "Team" });
  });

  it("renames a workspace", async () => {
    stub({ id: "w1", name: "Finance" });
    await renameWorkspace("w1", "Finance");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces/w1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ name: "Finance" });
  });

  it("deletes a workspace", async () => {
    stub({});
    await deleteWorkspace("w1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces/w1");
    expect(init.method).toBe("DELETE");
  });

  it("lists members", async () => {
    stub({ members: [] });
    await listMembers("w1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/workspaces/w1/members");
  });

  it("adds a member by Snowflake username", async () => {
    stub({ userId: "u1" }, 201);
    await addMember("w1", "BOB", "editor");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces/w1/members");
    expect(JSON.parse(init.body)).toEqual({ snowflakeUser: "BOB", role: "editor" });
  });

  it("changes a member's role", async () => {
    stub({ userId: "u1", role: "admin" });
    await setMemberRole("w1", "u1", "admin");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces/w1/members/u1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ role: "admin" });
  });

  it("removes a member", async () => {
    stub({});
    await removeMember("w1", "u1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces/w1/members/u1");
    expect(init.method).toBe("DELETE");
  });

  it("encodes ids that would otherwise break the path", async () => {
    stub({ members: [] });
    await addMember("w/1", "BOB", "viewer");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/workspaces/w%2F1/members");
  });

  it("moves a report", async () => {
    stub({ id: "r1", workspaceId: "w2" });
    await moveReport("r1", "w2");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/r1/move");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ workspaceId: "w2" });
  });
});
