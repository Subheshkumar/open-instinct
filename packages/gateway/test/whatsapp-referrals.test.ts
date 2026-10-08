import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeEvent } from "@open-instinct/core";
import { createGateway, type GatewayServer } from "../src/server.js";
import { UserStore, type UserRecord } from "../src/store.js";
import { silentLogger } from "../src/logger.js";
import type { WhatsAppGatewayConfig } from "../src/whatsapp.js";
import { fakeInkbox, fakeMaritime, readyUser, tempDir } from "./helpers.js";

const owner = "919876543210";
const otherOwner = "919876543211";
const businessNumber = "12345";
const publicNumber = "919111111111";
const config = {
  phoneNumberId: businessNumber,
  publicNumber,
  apiVersion: "v23.0",
  accessToken: "gateway-only-meta-token",
  appSecret: "test-meta-app-secret",
  verifyToken: "test-meta-verification-secret",
};
const servers: GatewayServer[] = [];
let messageSerial = 0;

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await server.drainWebhooks();
  }
});

function upstream() {
  const maritime = fakeMaritime();
  const sends: Array<{ to: string; text?: { body: string } }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://graph.facebook.com/")) {
      sends.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: `sent-${sends.length}` }] }));
    }
    if (init?.method === "DELETE") {
      maritime.existingAgents = maritime.existingAgents.filter((agent) => !String(url).endsWith(`/${agent.id}`));
      return new Response(null, { status: 204 });
    }
    return maritime.fetch(url, init);
  };
  return { maritime, sends, fetchImpl };
}

function payload(id: string, from: string, text: string, now: number, number = businessNumber) {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: number },
      contacts: [{ wa_id: from, profile: { name: "Test user" } }],
      messages: [{ id, from, timestamp: String(Math.floor(now / 1000)), type: "text", text: { body: text } }],
    } }] }],
  };
}

async function signedPost(base: string, body: unknown, valid = true) {
  const raw = JSON.stringify(body);
  return fetch(`${base}/webhooks/whatsapp`, {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", valid ? config.appSecret : "incorrect-secret").update(raw).digest("hex")}`,
    },
  });
}

async function serve(store: UserStore, api: ReturnType<typeof upstream>, bootstrapNumbers = [owner], inkbox?: ReturnType<typeof fakeInkbox>["provisioner"], overrides: Partial<WhatsAppGatewayConfig> = {}) {
  const server = createGateway({
    store,
    publicUrl: "https://rex.example.com",
    maritime: { apiKey: "gateway-only-maritime-token", agentImage: "rex-image" },
    whatsapp: { ...config, bootstrapNumbers, ...overrides },
    fetchImpl: api.fetchImpl,
    logger: silentLogger,
    inkbox,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function message(from: string, text: string, id = `message-${++messageSerial}`) {
    expect((await signedPost(base, payload(id, from, text, Date.now()))).status).toBe(200);
    // An acknowledged webhook is asynchronous. Wait for its actual handler,
    // including access admission, to finish before asserting absent VM calls.
    await vi.waitFor(() => {
      const file = join(store.dir, "whatsapp-inbox.json");
      expect(existsSync(file)).toBe(true);
      const receipt = JSON.parse(readFileSync(file, "utf8")).receipts.find((row: { id: string }) => row.id === `${businessNumber}:${id}`);
      expect(receipt?.status).toBe("done");
    });
  }
  return { server, base, message };
}

const chatCalls = (api: ReturnType<typeof upstream>) => api.maritime.calls.filter((call) => call.url.endsWith("/chat"));
const createCalls = (api: ReturnType<typeof upstream>) => api.maritime.calls.filter((call) => call.method === "POST" && call.url.endsWith("/api/agents"));
const guest = (index: number) => `91900000000${index}`;

async function boot(bootstrapNumbers = [owner], overrides: Partial<WhatsAppGatewayConfig> = {}) {
  const store = new UserStore(tempDir());
  const api = upstream();
  const app = await serve(store, api, bootstrapNumbers, undefined, overrides);
  await app.message(owner, "Hi Rex");
  expect(chatCalls(api)).toHaveLength(1);
  return { ...app, store, api };
}

async function invite(app: Awaited<ReturnType<typeof boot>>, from = owner) {
  const before = app.api.sends.length;
  await app.message(from, "REFERRAL");
  await vi.waitFor(() => expect(app.api.sends.slice(before).some((send) => send.to === from && /\/invite\//.test(send.text?.body ?? ""))).toBe(true));
  const text = app.api.sends.slice(before).find((send) => send.to === from && /\/invite\//.test(send.text?.body ?? ""))?.text?.body ?? "";
  const link = text.match(/https:\/\/rex\.example\.com\/invite\/([A-Za-z0-9_-]{43})/);
  expect(link, text).not.toBeNull();
  return { url: link![0], token: link![1]! };
}

function storedWhatsAppUser(id: string, from: string): UserRecord {
  return readyUser({
    id,
    channel: "whatsapp",
    whatsappId: from,
    whatsappPhoneNumberId: businessNumber,
    whatsappRelayToken: `relay-token-${id}`,
    whatsappLastInboundAt: Date.now(),
    phone: `+${from}`,
    handle: id,
  });
}

describe("invite-only Rex access", () => {
  it("blocks ordinary chat and referral generation from an unregistered signed sender without creating a VM", async () => {
    const store = new UserStore(tempDir());
    const api = upstream();
    const app = await serve(store, api, []);
    await app.message(guest(1), "Hi Rex");
    await app.message(guest(1), "REFERRAL");
    await vi.waitFor(() => expect(api.sends).toHaveLength(2));
    expect(api.sends.every((send) => send.to === guest(1) && /referral|invite/i.test(send.text?.body ?? ""))).toBe(true);
    expect(api.sends.some((send) => /\/invite\//.test(send.text?.body ?? ""))).toBe(false);
    expect(createCalls(api)).toHaveLength(0);
    expect(chatCalls(api)).toHaveLength(0);
    expect(store.byWhatsApp(guest(1), businessNumber)?.whatsappAccess).toBeUndefined();
  });

  it("requires a valid referral, valid Meta signature and the configured business number", async () => {
    const app = await boot();
    const { token } = await invite(app);
    const invalid = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
    await app.message(guest(1), `JOIN ${invalid}`);
    expect((await signedPost(app.base, payload("forged", guest(2), `JOIN ${token}`, Date.now()), false)).status).toBe(401);
    expect((await signedPost(app.base, payload("other-business", guest(3), `JOIN ${token}`, Date.now(), "another-business-number"))).status).toBe(200);
    expect(app.store.byWhatsApp(guest(1), businessNumber)?.whatsappAccess).toBeUndefined();
    expect(app.store.byWhatsApp(guest(2), businessNumber)).toBeUndefined();
    expect(app.store.byWhatsApp(guest(3), businessNumber)).toBeUndefined();
    expect(createCalls(app.api)).toHaveLength(1);
    expect(chatCalls(app.api)).toHaveLength(1);
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(0);
  });

  it("returns one persistent link per account and retains its five-person allowance across restart", async () => {
    const app = await boot();
    const first = await invite(app);
    expect(await invite(app)).toEqual(first);
    await app.message(guest(1), `JOIN ${first.token}`);
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await app.server.drainWebhooks();
    servers.splice(servers.indexOf(app.server), 1);
    const store = new UserStore(app.store.dir);
    const restarted = { ...app, store, ...await serve(store, app.api) };
    expect(await invite(restarted)).toEqual(first);
    expect(store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(1);
    expect(chatCalls(app.api)).toHaveLength(1);
  });

  it("accepts at most five distinct people even when six JOIN requests arrive concurrently", async () => {
    const app = await boot();
    const { token } = await invite(app);
    await Promise.all(Array.from({ length: 6 }, (_, i) => app.message(guest(i + 1), `JOIN ${token}`)));
    const recipients = app.store.all().filter((user) => user.whatsappAccess?.kind === "referral");
    expect(recipients).toHaveLength(5);
    const rejected = Array.from({ length: 6 }, (_, i) => guest(i + 1)).find((number) => !recipients.some((user) => user.whatsappId === number))!;
    await app.message(rejected, "Please order dinner");
    expect(app.store.byWhatsApp(rejected, businessNumber)?.whatsappAccess).toBeUndefined();
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(5);
    // JOIN and failed admission are gateway commands, never agent prompts.
    expect(chatCalls(app.api)).toHaveLength(1);
  });

  it("does not consume additional places for duplicate delivery, JOIN retries or an already active user", async () => {
    const app = await boot([owner, otherOwner]);
    await app.message(otherOwner, "Hi Rex");
    const { token } = await invite(app);
    await app.message(otherOwner, `JOIN ${token}`);
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(0);
    await app.message(guest(1), `JOIN ${token}`, "join-once");
    await app.message(guest(1), `JOIN ${token}`, "join-once");
    await app.message(guest(1), `JOIN ${token}`, "join-retry");
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(1);
    for (let i = 2; i <= 5; i++) await app.message(guest(i), `JOIN ${token}`);
    await app.message(guest(6), `JOIN ${token}`);
    expect(app.store.all().filter((user) => user.whatsappAccess?.kind === "referral")).toHaveLength(5);
    expect(app.store.byWhatsApp(guest(6), businessNumber)?.whatsappAccess).toBeUndefined();
  });

  it("routes each admitted person only to their own private agent and scopes replies to that account", async () => {
    const app = await boot();
    const { token } = await invite(app);
    for (const number of [guest(1), guest(2)]) {
      await app.message(number, `JOIN ${token}`);
      await app.message(number, `Hello from ${number}`);
    }
    expect(createCalls(app.api)).toHaveLength(3);
    expect(chatCalls(app.api)).toHaveLength(3);
    const users = app.store.all();
    expect(new Set(users.map((user) => user.maritimeAgentId)).size).toBe(3);
    expect(new Set(users.map((user) => user.whatsappRelayToken)).size).toBe(3);
    for (const call of chatCalls(app.api)) {
      const event = decodeEvent((call.body as { message: string }).message) as { message: { from: string } };
      const user = app.store.byWhatsApp(event.message.from, businessNumber)!;
      expect(call.url).toContain(`/agents/${user.maritimeAgentId}/chat`);
    }
    const first = app.store.byWhatsApp(guest(1), businessNumber)!;
    const second = app.store.byWhatsApp(guest(2), businessNumber)!;
    const crossed = await fetch(`${app.base}/api/whatsapp/send/${second.id}`, {
      method: "POST", headers: { authorization: `Bearer ${first.whatsappRelayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "crossed", text: "Private reply" }),
    });
    expect(crossed.status).toBe(401);
  });

  it("allows admitted recipients to generate their own five-person referral without sharing their agent", async () => {
    const app = await boot();
    const initial = await invite(app);
    await app.message(guest(1), `JOIN ${initial.token}`);
    const downstream = await invite(app, guest(1));
    expect(downstream.token).not.toBe(initial.token);
    await app.message(guest(2), `JOIN ${downstream.token}`);
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(1);
    const referrer = app.store.byWhatsApp(guest(1), businessNumber)!;
    expect(referrer.whatsappReferral?.recipients).toHaveLength(1);
    expect(app.store.byWhatsApp(guest(2), businessNumber)?.whatsappAccess?.referrerId).toBe(referrer.id);
  });

  it("blocks chat, referral generation and private replies while logged out, then restores the same account on LOGIN", async () => {
    const app = await boot();
    const { token } = await invite(app);
    await app.message(guest(1), `JOIN ${token}`);
    await app.message(guest(1), "Hello Rex");
    const user = app.store.byWhatsApp(guest(1), businessNumber)!;
    await app.message(guest(1), "LOGOUT");
    expect(app.store.get(user.id)?.whatsappLoggedOutAt).toBeDefined();
    await app.message(guest(1), "Order something for me");
    await app.message(guest(1), "REFERRAL");
    expect(chatCalls(app.api)).toHaveLength(2);
    expect(app.store.get(user.id)?.whatsappReferral).toBeUndefined();
    const response = await fetch(`${app.base}/api/whatsapp/send/${user.id}`, {
      method: "POST", headers: { authorization: `Bearer ${user.whatsappRelayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "logged-out-reply", text: "Must not be sent" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(app.api.sends.some((send) => send.text?.body === "Must not be sent")).toBe(false);
    await app.message(guest(1), "LOGIN");
    expect(app.store.get(user.id)?.whatsappLoggedOutAt).toBeUndefined();
    await app.message(guest(1), "Hello again Rex");
    expect(chatCalls(app.api)).toHaveLength(3);
    expect(createCalls(app.api)).toHaveLength(2);
    expect(app.store.byWhatsApp(guest(1), businessNumber)?.maritimeAgentId).toBe(user.maritimeAgentId);
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(1);
  });

  it("delivers account deletion and CANCEL notices while logged out without restoring chat access", async () => {
    const app = await boot();
    const { token } = await invite(app);
    await app.message(guest(1), `JOIN ${token}`);
    await app.message(guest(1), "Hello Rex");
    const user = app.store.byWhatsApp(guest(1), businessNumber)!;
    await app.message(guest(1), "LOGOUT");
    const loggedOutAt = app.store.get(user.id)?.whatsappLoggedOutAt;
    expect(loggedOutAt).toBeDefined();
    let before = app.api.sends.length;
    await app.message(guest(1), "delete my account");
    await vi.waitFor(() => expect(app.api.sends.slice(before).some((send) => send.to === guest(1) && /Reply DELETE within 10 minutes/.test(send.text?.body ?? ""))).toBe(true));
    expect(app.store.get(user.id)?.whatsappLoggedOutAt).toBe(loggedOutAt);
    const blockedReply = await fetch(`${app.base}/api/whatsapp/send/${user.id}`, {
      method: "POST", headers: { authorization: `Bearer ${user.whatsappRelayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "management-bypass", text: "Unauthorized reply", accountManagement: true }),
    });
    expect(blockedReply.status).toBe(403);
    before = app.api.sends.length;
    await app.message(guest(1), "CANCEL");
    await vi.waitFor(() => expect(app.api.sends.slice(before).some((send) => send.to === guest(1) && /account has been kept/.test(send.text?.body ?? ""))).toBe(true));
    expect(app.store.get(user.id)?.whatsappDeleteRequestedAt).toBeUndefined();
    expect(app.store.get(user.id)?.whatsappLoggedOutAt).toBe(loggedOutAt);
    await app.message(guest(1), "Can you order dinner?");
    expect(chatCalls(app.api)).toHaveLength(2);
    before = app.api.sends.length;
    await app.message(guest(1), "delete my account");
    await vi.waitFor(() => expect(app.api.sends.slice(before).some((send) => send.to === guest(1) && /Reply DELETE within 10 minutes/.test(send.text?.body ?? ""))).toBe(true));
    before = app.api.sends.length;
    await app.message(guest(1), "DELETE");
    await vi.waitFor(() => expect(app.api.sends.slice(before).some((send) => send.to === guest(1) && /account.*deleted/.test(send.text?.body ?? ""))).toBe(true));
    expect(app.store.get(user.id)).toBeUndefined();
    expect(chatCalls(app.api)).toHaveLength(2);
    expect(app.api.sends.some((send) => send.text?.body === "Unauthorized reply")).toBe(false);
  });

  it("does not consume an invitation when its public page is opened and exposes no owner credentials", async () => {
    const app = await boot();
    const { token } = await invite(app);
    const user = app.store.byWhatsApp(owner, businessNumber)!;
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${app.base}/invite/${token}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const page = await response.text();
      expect(page).toContain(`wa.me/${publicNumber}`);
      const joinLink = page.match(/href="(https:\/\/wa\.me\/[^\"]+)"/)?.[1];
      expect(joinLink).toBeDefined();
      expect(new URL(joinLink!).searchParams.get("text")).toBe(`JOIN ${token}`);
      for (const secret of [owner, user.id, user.whatsappRelayToken!, config.accessToken, config.appSecret, config.verifyToken, "gateway-only-maritime-token"]) expect(page).not.toContain(secret);
    }
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(0);
    expect(app.store.all()).toHaveLength(1);
    expect(createCalls(app.api)).toHaveLength(1);
    expect(chatCalls(app.api)).toHaveLength(1);
  });

  it("rejects invitations issued by an account being deleted or already removed", async () => {
    const app = await boot();
    const { token } = await invite(app);
    const referrer = app.store.byWhatsApp(owner, businessNumber)!;
    app.store.save({ ...referrer, status: "deleting" });
    await app.message(guest(1), `JOIN ${token}`);
    expect(app.store.byWhatsApp(guest(1), businessNumber)?.whatsappAccess).toBeUndefined();
    expect((await fetch(`${app.base}/invite/${token}`)).status).toBeGreaterThanOrEqual(400);
    app.store.remove(referrer.id);
    await app.message(guest(2), `JOIN ${token}`);
    expect(app.store.byWhatsApp(guest(2), businessNumber)?.whatsappAccess).toBeUndefined();
    expect((await fetch(`${app.base}/invite/${token}`)).status).toBeGreaterThanOrEqual(400);
    expect(createCalls(app.api)).toHaveLength(1);
    expect(chatCalls(app.api)).toHaveLength(1);
  });

  it("preserves the five-person limit when an invited person deletes their account", async () => {
    const app = await boot();
    const { token } = await invite(app);
    for (let i = 1; i <= 5; i++) await app.message(guest(i), `JOIN ${token}`);
    await app.message(guest(1), "delete my account");
    await app.message(guest(1), "DELETE");
    expect(app.store.byWhatsApp(guest(1), businessNumber)).toBeUndefined();
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(5);
    await app.message(guest(6), `JOIN ${token}`);
    expect(app.store.byWhatsApp(guest(6), businessNumber)?.whatsappAccess).toBeUndefined();
  });

  it("does not spend a referral place when global capacity rejects signup", async () => {
    const app = await boot([owner, otherOwner], { maxUsers: 2 });
    await app.message(otherOwner, "Hello Rex");
    const { token } = await invite(app);
    await app.message(guest(1), `JOIN ${token}`);
    expect(app.store.byWhatsApp(guest(1), businessNumber)).toBeUndefined();
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(0);
    await app.message(otherOwner, "delete my account");
    await app.message(otherOwner, "DELETE");
    await app.message(guest(1), `JOIN ${token}`);
    expect(app.store.byWhatsApp(guest(1), businessNumber)?.whatsappAccess?.kind).toBe("referral");
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(1);
  });

  it("keeps rolling signup limits while invalid referrals and duplicate joins do not consume them", async () => {
    const app = await boot([owner], { maxUsers: 10, newUsersPerHour: 2 });
    const { token } = await invite(app);
    const invalid = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
    await app.message(guest(1), `JOIN ${invalid}`);
    await app.message(guest(2), `JOIN ${invalid}`);
    await app.message(guest(1), `JOIN ${token}`, "quota-valid");
    await app.message(guest(1), `JOIN ${token}`, "quota-valid");
    await app.message(guest(1), `JOIN ${token}`, "quota-retry");
    await app.message(guest(2), `JOIN ${token}`);
    expect(app.store.byWhatsApp(guest(1), businessNumber)?.whatsappAccess?.kind).toBe("referral");
    expect(app.store.byWhatsApp(guest(2), businessNumber)).toBeUndefined();
    expect(app.store.byWhatsApp(owner, businessNumber)?.whatsappReferral?.recipients).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(app.store.dir, "whatsapp-signups.json"), "utf8"))).toHaveLength(2);
  });

  it("grandfathers existing accounts once without granting new records access on restart", async () => {
    let store = new UserStore(tempDir());
    const existing = store.save(storedWhatsAppUser("usr_existing", owner));
    const api = upstream();
    const first = await serve(store, api, []);
    await first.message(owner, "Existing account");
    expect(store.get(existing.id)?.whatsappAccess?.kind).toBe("existing");
    expect(chatCalls(api)).toHaveLength(1);
    const blocked = store.save(storedWhatsAppUser("usr_unregistered", guest(1)));
    await first.message(guest(1), "New record without login");
    expect(chatCalls(api)).toHaveLength(1);
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    await first.server.drainWebhooks();
    servers.splice(servers.indexOf(first.server), 1);
    store = new UserStore(store.dir);
    const second = await serve(store, api, []);
    await second.message(guest(1), "Still not logged in");
    expect(store.get(blocked.id)?.whatsappAccess).toBeUndefined();
    expect(chatCalls(api)).toHaveLength(1);
    const response = await fetch(`${second.base}/api/whatsapp/send/${blocked.id}`, {
      method: "POST", headers: { authorization: `Bearer ${blocked.whatsappRelayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "blocked-reply", text: "Should not be delivered" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(api.sends.some((send) => send.text?.body === "Should not be delivered")).toBe(false);
  });

  it("cannot provision an unauthorized WhatsApp record through recovery or the browser signup form", async () => {
    const store = new UserStore(tempDir());
    const api = upstream();
    const inkbox = fakeInkbox();
    const app = await serve(store, api, [], inkbox.provisioner);
    const blocked = store.save({ ...storedWhatsAppUser("usr_pending", guest(1)), handle: "rex-pending", status: "provisioning", maritimeAgentId: undefined });
    expect(app.server.resumePending()).toBe(0);
    const response = await fetch(`${app.base}/api/signup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: blocked.name, phone: blocked.phone, handle: blocked.handle }),
    });
    expect(response.status).toBeLessThan(500);
    await app.server.drainWebhooks();
    expect(inkbox.calls.filter((call) => call !== "routerInfo")).toHaveLength(0);
    expect(createCalls(api)).toHaveLength(0);
    expect(store.get(blocked.id)?.whatsappAccess).toBeUndefined();
  });
});
