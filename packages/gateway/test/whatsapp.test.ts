import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeEvent } from "@open-instinct/core";
import { createGateway } from "../src/server.js";
import { UserStore } from "../src/store.js";
import { silentLogger } from "../src/logger.js";
import { readEnv } from "../src/main.js";
import { fakeMaritime, tempDir } from "./helpers.js";

const config = { phoneNumberId: "12345", apiVersion: "v23.0", accessToken: "meta-only-at-gateway", appSecret: "app-secret", verifyToken: "verify-secret" };
const servers: ReturnType<typeof createGateway>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { await new Promise<void>((r) => s.close(() => r())); await s.drainWebhooks(); } });

function upstream() {
  const maritime = fakeMaritime();
  const sends: any[] = [];
  const deletes: string[] = [];
  let failDelete = false;
  let failSend = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://graph.facebook.com/")) {
      sends.push(JSON.parse(String(init?.body)));
      if (failSend) throw new Error("connection lost");
      return new Response(JSON.stringify({ messages: [{ id: `sent-${sends.length}` }] }));
    }
    if (init?.method === "DELETE") {
      deletes.push(String(url));
      if (failDelete) return new Response("{}", { status: 503 });
      maritime.existingAgents = maritime.existingAgents.filter((a) => !String(url).endsWith(`/${a.id}`));
      return new Response(null, { status: 204 });
    }
    return maritime.fetch(url, init);
  };
  return { maritime, sends, deletes, fetchImpl, setFailDelete: (value: boolean) => { failDelete = value; }, setFailSend: (value: boolean) => { failSend = value; } };
}

async function serve(store: UserStore, api: ReturnType<typeof upstream>, opts: { now?: () => number; revokeAppsForUser?: (user: import("../src/store.js").UserRecord) => Promise<void>; config?: Partial<typeof config> & { messagesPerDay?: number; repliesPerDay?: number; notificationTemplate?: string; maxUsers?: number; newUsersPerHour?: number } } = {}) {
  const server = createGateway({ store, fetchImpl: api.fetchImpl, now: opts.now, revokeAppsForUser: opts.revokeAppsForUser, logger: silentLogger, publicUrl: "https://rex.example.com", maritime: { apiKey: "maritime", agentImage: "rex-image" }, whatsapp: { ...config, bootstrapNumbers: ["919876543210", "919000000000"], ...opts.config } });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}
function payload(id: string, from = "919876543210", text = "hello", timestamp = Date.now(), number = config.phoneNumberId) {
  return { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: number }, contacts: [{ wa_id: from, profile: { name: "Sam" } }], messages: [{ id, from, timestamp: String(Math.floor(timestamp / 1000)), type: "text", text: { body: text } }] } }] }] };
}
async function post(base: string, body: unknown, valid = true) {
  const raw = JSON.stringify(body);
  return fetch(`${base}/webhooks/whatsapp`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", valid ? config.appSecret : "wrong").update(raw).digest("hex")}` } });
}
const chatCalls = (api: ReturnType<typeof upstream>) => api.maritime.calls.filter((c) => c.url.endsWith("/chat"));
const createCalls = (api: ReturnType<typeof upstream>) => api.maritime.calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/agents"));
async function reply(base: string, user: any, id: string, text = "finished", extra = {}) {
  return fetch(`${base}/api/whatsapp/send/${user.id}`, { method: "POST", headers: { Authorization: `Bearer ${user.whatsappRelayToken}`, "content-type": "application/json" }, body: JSON.stringify({ id, text, ...extra }) });
}

describe("public WhatsApp gateway", () => {
  it("verifies Meta's challenge and authenticates messages before provisioning", async () => {
    const store = new UserStore(tempDir()); const api = upstream(); const { base } = await serve(store, api);
    const verification = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=1234`);
    expect(verification.status).toBe(200); expect(await verification.text()).toBe("1234");
    expect((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=bad`)).status).toBe(403);
    expect((await post(base, payload("untrusted"), false)).status).toBe(401);
    expect((await post(base, payload("other-number", undefined, undefined, undefined, "999"))).status).toBe(200);
    expect(store.all()).toHaveLength(0); expect(api.maritime.calls).toHaveLength(0);
  });

  it("creates exactly one private VM per sender and reuses it for concurrent messages and duplicate deliveries", async () => {
    const store = new UserStore(tempDir()); const api = upstream(); const { base } = await serve(store, api);
    await Promise.all([post(base, payload("one")), post(base, payload("two")), post(base, payload("other", "919000000000")), post(base, payload("one"))]);
    await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(3));
    expect(store.all()).toHaveLength(2); expect(createCalls(api)).toHaveLength(2);
    const [a, b] = store.all();
    expect(a?.maritimeAgentId).not.toBe(b?.maritimeAgentId);
    expect(a?.whatsappRelayToken).not.toBe(b?.whatsappRelayToken);
    for (const call of createCalls(api)) {
      const env = (call.body as any).initialEnvVars;
      expect(env.find((e: any) => e.key === "INSTINCT_AGENT_NAME").value).toBe("Rex");
      expect(env.find((e: any) => e.key === "WHATSAPP_RELAY_TOKEN").isSecret).toBe(true);
      expect(env.some((e: any) => /WHATSAPP_ACCESS_TOKEN|INKBOX_API_KEY/.test(e.key))).toBe(false);
      expect(env.find((e: any) => e.key === "INSTINCT_AGENT_HANDLE").value).toMatch(/^rex-/);
    }
    for (const call of chatCalls(api)) {
      const event = decodeEvent((call.body as any).message) as any;
      const user = store.byWhatsApp(event.message.from, config.phoneNumberId)!;
      expect(call.url).toContain(`/agents/${user.maritimeAgentId}/chat`);
      expect(event.type).toBe("whatsapp.message");
    }
  });

  it("delivers background replies to the bound owner and rejects cross-user tokens or recipients", async () => {
    const store = new UserStore(tempDir()); const api = upstream(); const { base } = await serve(store, api);
    await post(base, payload("one")); await post(base, payload("two", "919000000000"));
    await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(2));
    const a = store.byWhatsApp("919876543210", config.phoneNumberId)!; const b = store.byWhatsApp("919000000000", config.phoneNumberId)!;
    expect((await reply(base, { ...a, whatsappRelayToken: b.whatsappRelayToken }, "bad")).status).toBe(401);
    expect((await reply(base, a, "bad", "hello", { to: b.whatsappId })).status).toBe(400);
    expect((await reply(base, a, "result")).status).toBe(202);
    expect((await reply(base, a, "result")).status).toBe(202);
    await vi.waitFor(() => expect(api.sends).toHaveLength(1));
    expect(api.sends[0]).toMatchObject({ to: a.whatsappId, type: "text", text: { body: "finished" } });
  });

  it("persists daily quotas and private VM routing across restarts", async () => {
    const dir = tempDir(); let store = new UserStore(dir); const api = upstream();
    const first = await serve(store, api, { config: { messagesPerDay: 1, repliesPerDay: 1 } });
    await post(first.base, payload("one")); await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(1));
    const user = store.all()[0]!;
    await reply(first.base, user, "r1"); await vi.waitFor(() => expect(api.sends).toHaveLength(1));
    await first.server.drainWebhooks(); await new Promise<void>((r) => first.server.close(() => r())); servers.splice(servers.indexOf(first.server), 1);
    store = new UserStore(dir); const second = await serve(store, api, { config: { messagesPerDay: 1, repliesPerDay: 1 } });
    await post(second.base, payload("two")); await vi.waitFor(() => expect(api.sends).toHaveLength(2));
    expect(chatCalls(api)).toHaveLength(1); expect(createCalls(api)).toHaveLength(1);
    expect(store.all()[0]?.maritimeAgentId).toBe(user.maritimeAgentId);
    expect((await reply(second.base, user, "r2")).status).toBe(429);
    const health = await (await fetch(`${second.base}/health`)).json();
    expect(JSON.stringify(health)).not.toContain(user.whatsappRelayToken);
  });

  it("requires account-deletion confirmation, removes the VM and invalidates the old reply token", async () => {
    let clock = Date.now(); const store = new UserStore(tempDir()); const api = upstream(); const { base } = await serve(store, api, { now: () => clock });
    await post(base, payload("one", undefined, undefined, clock)); await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(1));
    const user = store.all()[0]!;
    clock += 2000; await post(base, payload("request", undefined, "delete my account", clock));
    await vi.waitFor(() => expect(api.sends).toHaveLength(1)); expect(api.deletes).toHaveLength(0);
    clock += 2000; await post(base, payload("confirmation", undefined, "DELETE", clock));
    await vi.waitFor(() => expect(store.all()).toHaveLength(0)); expect(api.deletes).toEqual([`https://api.maritime.sh/api/agents/${user.maritimeAgentId}`]);
    expect((await reply(base, user, "old-token")).status).toBe(401);
    await post(base, payload("old-queued", undefined, "hello", clock - 3000));
    expect(store.all()).toHaveLength(0);
    clock += 2000; await post(base, payload("fresh", undefined, "hello again", clock));
    await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(2));
    expect(store.all()[0]?.id).not.toBe(user.id); expect(createCalls(api)).toHaveLength(2);
  });

  it("keeps a deleting account until remote VM removal succeeds and resumes cleanup", async () => {
    const store = new UserStore(tempDir()); const api = upstream(); const { base, server } = await serve(store, api);
    await post(base, payload("one")); await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(1)); const user = store.all()[0]!;
    await post(base, payload("request", undefined, "delete my account")); await vi.waitFor(() => expect(api.sends).toHaveLength(1));
    api.setFailDelete(true); await post(base, payload("confirm", undefined, "DELETE"));
    await vi.waitFor(() => expect(api.deletes).toHaveLength(1)); expect(store.get(user.id)?.status).toBe("deleting");
    expect((await reply(base, user, "disabled")).status).toBe(410);
    api.setFailDelete(false); expect(server.resumePending()).toBe(1);
    await vi.waitFor(() => expect(store.get(user.id)).toBeUndefined()); expect(api.deletes).toHaveLength(2);
  });

  it("records ambiguous Meta delivery for recovery and does not resend it automatically", async () => {
    const store = new UserStore(tempDir()); const api = upstream(); const { base } = await serve(store, api);
    await post(base, payload("one")); await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(1));
    api.setFailSend(true); await reply(base, store.all()[0]!, "uncertain");
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(store.dir, "whatsapp-outbox.json"), "utf8")).receipts[0].status).toBe("uncertain"));
    expect(api.sends).toHaveLength(1);
  });

  it("keeps deletion pending until private connected-account cleanup succeeds without touching another user", async () => {
    const store = new UserStore(tempDir()); const api = upstream();
    const revoke = vi.fn().mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValueOnce(undefined);
    const { base, server } = await serve(store, api, { revokeAppsForUser: revoke });
    await post(base, payload("one")); await post(base, payload("other", "919000000000"));
    await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(2));
    const user = store.byWhatsApp("919876543210", config.phoneNumberId)!;
    const other = store.byWhatsApp("919000000000", config.phoneNumberId)!;
    await post(base, payload("request", undefined, "delete my account"));
    await vi.waitFor(() => expect(api.sends).toHaveLength(1));
    await post(base, payload("confirm", undefined, "DELETE"));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    expect(store.get(user.id)?.status).toBe("deleting");
    expect((await reply(base, user, "disabled")).status).toBe(410);
    expect(server.resumePending()).toBe(1);
    await vi.waitFor(() => expect(store.get(user.id)).toBeUndefined());
    expect(revoke.mock.calls.map(([record]) => record.id)).toEqual([user.id, user.id]);
    expect(store.get(other.id)).toEqual(other);
    expect(api.deletes.every((url) => url.endsWith(`/${user.maritimeAgentId}`))).toBe(true);
  });

  it("enforces active-account capacity and preserves the rolling signup cap after deletion and restart", async () => {
    let clock = Date.now(); const dir = tempDir(); const api = upstream(); let store = new UserStore(dir);
    const first = await serve(store, api, { now: () => clock, config: { maxUsers: 1, newUsersPerHour: 1 } });
    await post(first.base, payload("one", undefined, undefined, clock));
    await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(1));
    await post(first.base, payload("capacity", "919000000000", "hello", clock));
    await vi.waitFor(() => expect(api.sends).toHaveLength(1));
    expect(api.sends[0].text.body).toContain("capacity");
    expect(createCalls(api)).toHaveLength(1);
    clock += 2000; await post(first.base, payload("request", undefined, "delete my account", clock));
    await vi.waitFor(() => expect(api.sends).toHaveLength(2));
    clock += 2000; await post(first.base, payload("confirm", undefined, "DELETE", clock));
    await vi.waitFor(() => expect(store.all()).toHaveLength(0));
    await first.server.drainWebhooks(); await new Promise<void>((r) => first.server.close(() => r())); servers.splice(servers.indexOf(first.server), 1);
    store = new UserStore(dir);
    const second = await serve(store, api, { now: () => clock, config: { maxUsers: 1, newUsersPerHour: 1 } });
    const sentBefore = api.sends.length;
    await post(second.base, payload("hour-cap", "919000000000", "hello", clock));
    await vi.waitFor(() => expect(api.sends).toHaveLength(sentBefore + 1));
    expect(store.all()).toHaveLength(0); expect(createCalls(api)).toHaveLength(1);
    clock += 3600_000;
    await post(second.base, payload("hour-reset", "919000000000", "hello", clock));
    await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(2));
    expect(createCalls(api)).toHaveLength(2);
  });

  it("uses the configured notification template when a scheduled reply is outside the text window", async () => {
    let clock = Date.now(); const store = new UserStore(tempDir()); const api = upstream(); const { base } = await serve(store, api, { now: () => clock, config: { notificationTemplate: "rex_update" } });
    await post(base, payload("one", undefined, undefined, clock)); await vi.waitFor(() => expect(chatCalls(api)).toHaveLength(1));
    clock += 25 * 3600_000; await reply(base, store.all()[0]!, "scheduled", "Your reminder");
    await vi.waitFor(() => expect(api.sends).toHaveLength(1));
    expect(api.sends[0]).toMatchObject({ type: "template", template: { name: "rex_update", language: { code: "en" } } });
  });

  it("validates complete gateway credentials and operator limits", () => {
    expect(() => readEnv({ MARITIME_API_KEY: "mk", WHATSAPP_ACCESS_TOKEN: "partial" })).toThrow(/WHATSAPP_APP_SECRET/);
    const env = { MARITIME_API_KEY: "mk", GATEWAY_PUBLIC_URL: "https://rex.test", INSTINCT_AGENT_IMAGE: "rex-image", WHATSAPP_ACCESS_TOKEN: "secret", WHATSAPP_APP_SECRET: "app", WHATSAPP_VERIFY_TOKEN: "verify", WHATSAPP_PHONE_NUMBER_ID: "12345", WHATSAPP_API_VERSION: "v23.0" };
    expect(readEnv(env).whatsapp).toMatchObject({ messagesPerDay: 100, maxUsers: 100 });
    expect(readEnv(env).agentExtraEnv).toMatchObject({ INSTINCT_SPEND_PER_ACTION_USD: "25", INSTINCT_SPEND_PER_DAY_USD: "50", INSTINCT_SPEND_ASK_ABOVE_USD: "0" });
    expect(() => readEnv({ ...env, WHATSAPP_MESSAGES_PER_DAY: "NaN" })).toThrow(/WHATSAPP_MESSAGES_PER_DAY/);
    expect(() => readEnv({ ...env, INSTINCT_AGENT_IMAGE: "" })).toThrow(/INSTINCT_AGENT_IMAGE/);
    expect(() => readEnv({ ...env, GATEWAY_PUBLIC_URL: "http://rex.test" })).toThrow(/HTTPS/);
  });
});
