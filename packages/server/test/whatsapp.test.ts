import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { encodeEvent } from "@open-instinct/core";
import { whatsappEvent } from "@open-instinct/whatsapp";
import { boot, operatorSpendLimits } from "../src/boot.js";
import { closeInkboxInbox, createHttpServer } from "../src/http.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
describe("private WhatsApp agents", () => {
  it("runs messages on the WhatsApp channel, sends completed replies through the private relay, and rejects another owner", async () => {
    const faux = registerFauxProvider();
    const sends: Array<{ url: string; headers: any; body: any }> = [];
    const app = await boot({ INSTINCT_DATA_DIR: mkdtempSync(join(tmpdir(), "wa-agent-")), INSTINCT_OWNER_PHONE: "+919876543210", INSTINCT_AGENT_HANDLE: "rex-private-user", INSTINCT_AGENT_NAME: "Rex", INSTINCT_OWNER_CHANNEL: "whatsapp", INSTINCT_COMPUTER: "none", WHATSAPP_PHONE_NUMBER_ID: "12345", WHATSAPP_RELAY_URL: "https://rex.example.com/api/whatsapp/send/private-user", WHATSAPP_RELAY_TOKEN: "private-token" }, {
      model: faux.getModel(), streamFn: streamSimple as StreamFn, logger: () => {},
      fetchImpl: async (url, init) => { sends.push({ url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) }); return new Response("{}", { status: 202 }); },
    });
    const server = createHttpServer(app, { env: {} });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(async () => { await new Promise<void>((r) => server.close(() => r())); await closeInkboxInbox(app); await app.close(); faux.unregister(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const msg = { id: "wamid.first", from: "919876543210", phoneNumberId: "12345", text: "hello", timestamp: Math.floor(Date.now() / 1000), supported: true };
    faux.setResponses([fauxAssistantMessage("Hello from your private Rex.")]);
    const send = (event: unknown) => fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: encodeEvent(event) }) });
    expect((await send(whatsappEvent(msg))).status).toBe(200);
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ url: "https://rex.example.com/api/whatsapp/send/private-user", headers: { Authorization: "Bearer private-token" }, body: { text: "Hello from your private Rex." } });
    expect(app.config.agent.handle).toBe("rex-private-user");
    const foreign = await send(whatsappEvent({ ...msg, id: "wamid.foreign", from: "919000000000" }));
    expect(await foreign.json()).toMatchObject({ blocked: expect.stringContaining("owner") });
    expect(sends).toHaveLength(1);
    await send(whatsappEvent(msg)); // Duplicate admission does not invoke the model or relay again.
    expect(sends).toHaveLength(1);
  });

  it("validates operator spending limits at startup", () => {
    expect(operatorSpendLimits({})).toBeUndefined();
    expect(operatorSpendLimits({ INSTINCT_SPEND_PER_ACTION_USD: "12" })).toEqual({ perActionUsd: 12, perDayUsd: 50, askAbove: 0 });
    expect(() => operatorSpendLimits({ INSTINCT_SPEND_PER_ACTION_USD: "NaN" })).toThrow(/spending limits/);
  });
});
