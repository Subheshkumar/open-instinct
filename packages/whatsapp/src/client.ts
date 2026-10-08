export interface WhatsAppClientOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

/** A failed send may have been accepted remotely; callers must not blindly replay it. */
export class WhatsAppSendError extends Error {
  constructor(readonly status: number | undefined, readonly code?: number) {
    super(status ? `WhatsApp send failed (${status}${code ? `, code ${code}` : ""})` : "WhatsApp send outcome is unknown");
    this.name = "InboundUncertainError";
  }
}

export class WhatsAppClient {
  private readonly url: string;
  constructor(private readonly opts: WhatsAppClientOptions) {
    if (!/^v\d+\.\d+$/.test(opts.apiVersion) || !/^\d+$/.test(opts.phoneNumberId) || !opts.accessToken) throw new Error("Invalid WhatsApp Cloud API configuration");
    this.url = `https://graph.facebook.com/${opts.apiVersion}/${opts.phoneNumberId}/messages`;
  }

  async sendText(to: string, text: string): Promise<void> {
    if (!text.trim() || text.length > 16_384) throw new Error("WhatsApp text must be between 1 and 16384 characters");
    // Keep each message below Meta's 4096-character limit, including surrogate pairs.
    const chars = Array.from(text);
    for (let start = 0; start < chars.length; start += 2000) {
      await this.send(to, { type: "text", text: { body: chars.slice(start, start + 2000).join(""), preview_url: false } });
    }
  }

  async sendTemplate(to: string, text: string, name: string, language: string): Promise<void> {
    await this.send(to, { type: "template", template: { name, language: { code: language }, components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 1000) }] }] } });
  }

  private async send(to: string, payload: Record<string, unknown>): Promise<void> {
    if (!/^\d{7,15}$/.test(to)) throw new Error("Invalid WhatsApp recipient");
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(this.url, {
        method: "POST", headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new WhatsAppSendError(undefined); }
    let body: { error?: { code?: number }; messages?: Array<{ id?: string }> };
    try { body = await res.json() as typeof body; } catch { throw new WhatsAppSendError(res.status); }
    if (!res.ok || !body.messages?.[0]?.id) throw new WhatsAppSendError(res.status, body.error?.code);
  }
}
