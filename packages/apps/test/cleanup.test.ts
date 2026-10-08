import { describe, expect, it, vi } from "vitest";
import { revokeUserConnections } from "../src/cleanup.js";

describe("connected-account deletion", () => {
  it("collects every page for exactly one user and tolerates already-removed credentials", async () => {
    const list = vi.fn().mockResolvedValueOnce({ items: [{ id: "a", userId: "rex-user" }], nextCursor: "next" }).mockResolvedValueOnce({ items: [{ id: "b", userId: "rex-user" }] });
    const remove = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce({ status: 404 });
    await revokeUserConnections("key", "rex-user", { connectedAccounts: { list, delete: remove } });
    expect(list.mock.calls.map((call) => call[0])).toEqual([{ userIds: ["rex-user"], accountType: "PRIVATE", limit: 100 }, { userIds: ["rex-user"], accountType: "PRIVATE", limit: 100, cursor: "next" }]);
    expect(remove.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  });
  it("handles the SDK's normalized response without a userId and excludes shared credentials", async () => {
    const remove = vi.fn();
    const list = vi.fn().mockResolvedValueOnce({ items: [{ id: "private" }] }).mockResolvedValueOnce({ items: [{ id: "shared", experimental: { accountType: "SHARED" } }] });
    const client = { connectedAccounts: { list, delete: remove } };
    await revokeUserConnections("key", "rex-user", client);
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(revokeUserConnections("key", "rex-user", client)).rejects.toThrow(/owner/);
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("refuses to delete any connection if the provider returns another user's account", async () => {
    const remove = vi.fn();
    await expect(revokeUserConnections("key", "rex-user", { connectedAccounts: { list: vi.fn().mockResolvedValue({ items: [{ id: "foreign", userId: "other-user" }] }), delete: remove } })).rejects.toThrow(/owner/);
    expect(remove).not.toHaveBeenCalled();
  });
});
