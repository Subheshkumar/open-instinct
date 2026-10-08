import { randomUUID } from "node:crypto";
import type { Outbox, OutboundMessage, Principal } from "@open-instinct/core";

export interface WhatsAppRelayOptions {
  url: string;
  token: string;
  ownerPhone: string;
  fetchImpl?: typeof fetch;
}

/** Agents never receive the shared Meta credential; their token only admits sends to their own user. */
export class WhatsAppRelayOutbox implements Outbox {
  constructor(private readonly opts: WhatsAppRelayOptions) {
    const url = new URL(opts.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("WhatsApp relay requires HTTPS");
    if (!opts.token || !opts.ownerPhone) throw new Error("WhatsApp relay requires an owner and token");
  }

  async send(msg: OutboundMessage, _ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    if (msg.channel !== "whatsapp") throw new Error(`WhatsApp relay cannot deliver ${msg.channel}`);
    const recipients = Array.isArray(msg.to) ? msg.to : msg.to ? [msg.to] : [];
    if (recipients.some((to) => to.replace(/\D/g, "") !== this.opts.ownerPhone.replace(/\D/g, ""))) throw new Error("WhatsApp relay can only reach its own owner");
    if (!msg.text.trim()) return;
    if (msg.mediaUrls?.length) throw new Error("WhatsApp media delivery is not configured");
    const body = JSON.stringify({ id: randomUUID(), text: msg.text });
    // Admission is idempotent at the gateway. Retries reuse the same id and never invoke the model again.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await (this.opts.fetchImpl ?? fetch)(this.opts.url, {
          method: "POST", headers: { Authorization: `Bearer ${this.opts.token}`, "Content-Type": "application/json" }, body,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return;
        if (res.status < 500 && res.status !== 429) throw new RelayRejectedError(res.status);
      } catch (error) { if (error instanceof RelayRejectedError) throw error; }
    }
    throw new Error("WhatsApp relay admission failed");
  }
}

class RelayRejectedError extends Error {
  constructor(status: number) { super(`WhatsApp relay rejected the message (${status})`); }
}
