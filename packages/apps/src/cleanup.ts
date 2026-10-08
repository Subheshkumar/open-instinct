import { Composio } from "@composio/core";

export interface AccountCleanupClient {
  connectedAccounts: {
    list(query: { userIds: string[]; accountType: "PRIVATE"; limit: number; cursor?: string }, opts?: { signal: AbortSignal }): Promise<{ items: Array<{ id: string; userId?: string; experimental?: { accountType?: string } }>; nextCursor?: string | null }>;
    delete(id: string, opts?: { signal: AbortSignal }): Promise<unknown>;
  };
}

/** Remove only this user's provider-held credentials after their agent has stopped. */
export async function revokeUserConnections(apiKey: string, userId: string, client: AccountCleanupClient = new Composio({ apiKey })): Promise<void> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 100) throw new Error("Too many connected-account pages during deletion");
    const result = await client.connectedAccounts.list({ userIds: [userId], accountType: "PRIVATE", limit: 100, ...(cursor ? { cursor } : {}) }, { signal: AbortSignal.timeout(30_000) });
    for (const account of result.items) {
      // SDK 0.22 omits userId from normalized responses; the API filters by the exact user id.
      if ((account.userId !== undefined && account.userId !== userId) || account.experimental?.accountType === "SHARED") throw new Error("Connected-account owner did not match the account being deleted");
      ids.add(account.id);
    }
    if (!result.nextCursor) break;
    if (cursors.has(result.nextCursor)) throw new Error("Repeated connected-account cursor during deletion");
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  for (const id of ids) {
    try { await client.connectedAccounts.delete(id, { signal: AbortSignal.timeout(30_000) }); }
    catch (error) { if ((error as { status?: number })?.status !== 404) throw error; }
  }
}
