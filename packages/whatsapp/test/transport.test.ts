import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseWhatsAppEvent, parseWhatsAppWebhook, secretMatches, verifyWhatsAppSignature, whatsappEvent, WhatsAppClient, WhatsAppRelayOutbox } from "../src/index.js";

const message = { id: "wamid.1", from: "919876543210", phoneNumberId: "12345", text: "hello", timestamp: 1791369000, supported: true };
describe("WhatsApp transport", () => {
  it("authenticates raw bytes and rejects malformed or altered signatures", () => {
    const raw = Buffer.from('{"text":"hello"}');
    const signature = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
    expect(verifyWhatsAppSignature(raw, signature, "secret")).toBe(true);
    expect(verifyWhatsAppSignature(Buffer.from("{}"), signature, "secret")).toBe(false);
    expect(verifyWhatsAppSignature(raw, "sha256=0", "secret")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });

  it("extracts batched text and interactive replies while excluding other numbers and status receipts", () => {
    const payload = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "12345" }, contacts: [{ wa_id: message.from, profile: { name: "Sam" } }], statuses: [{ id: "status" }],
      messages: [{ id: message.id, from: message.from, timestamp: String(message.timestamp), type: "text", text: { body: "hello" } },
        { id: "wamid.2", from: message.from, timestamp: message.timestamp, type: "interactive", interactive: { button_reply: { title: "YES" } } },
        { id: "wamid.3", from: message.from, timestamp: message.timestamp, type: "audio" }],
    } }] }] };
    expect(parseWhatsAppWebhook(payload, "12345").map((m) => [m.text, m.supported, m.name])).toEqual([["hello", true, "Sam"], ["YES", true, "Sam"], ["", false, "Sam"]]);
    expect(parseWhatsAppWebhook(payload, "another")).toEqual([]);
  });

  it("binds relayed messages to the private agent's owner and business number", () => {
    const event = whatsappEvent(message);
    expect(parseWhatsAppEvent(event, ["+919876543210"], "12345")).toMatchObject({ channel: "whatsapp", from: "+919876543210", id: "whatsapp:12345:wamid.1", conversationKey: "whatsapp:12345:919876543210" });
    expect(parseWhatsAppEvent(event, ["+919000000000"], "12345")).toBeUndefined();
    expect(parseWhatsAppEvent(event, ["+919876543210"], "99999")).toBeUndefined();
    expect(parseWhatsAppEvent(whatsappEvent({ ...message, timestamp: Infinity }), ["+919876543210"], "12345")).toBeUndefined();
  });

  it("sends Cloud API payloads and splits long Unicode replies without broken characters", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const client = new WhatsAppClient({ accessToken: "meta-secret", phoneNumberId: "12345", apiVersion: "v23.0", fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      expect(init?.headers).toMatchObject({ Authorization: "Bearer meta-secret" });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.sent" }] }));
    } });
    await client.sendText(message.from, "🌼".repeat(3000));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v23.0/12345/messages");
    expect(calls.map((c) => c.body.text.body).join("")).toBe("🌼".repeat(3000));
    expect(calls.every((c) => c.body.text.body.length <= 4096 && c.body.to === message.from)).toBe(true);
  });

  it("treats ambiguous Meta sends as uncertain rather than repeating them", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network closed after send"); });
    const client = new WhatsAppClient({ accessToken: "secret", phoneNumberId: "12345", apiVersion: "v23.0", fetchImpl });
    await expect(client.sendText(message.from, "hello")).rejects.toMatchObject({ name: "InboundUncertainError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries relay admission with one id and refuses to send to a different user", async () => {
    const bodies: string[] = [];
    const outbox = new WhatsAppRelayOutbox({ url: "https://gateway.test/api/whatsapp/send/u", token: "private", ownerPhone: "+919876543210", fetchImpl: async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: bodies.length === 1 ? 503 : 202 });
    } });
    const ctx = { principal: { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: "Sam" }, conversationKey: "whatsapp:test" };
    await outbox.send({ channel: "whatsapp", text: "done" }, ctx);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    await expect(outbox.send({ channel: "whatsapp", text: "wrong", to: "+919000000000" }, ctx)).rejects.toThrow(/own owner/);
    expect(bodies).toHaveLength(2);
  });
});
