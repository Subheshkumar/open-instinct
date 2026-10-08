import type { InboundMessage } from "@open-instinct/core";

export const WHATSAPP_MESSAGE_EVENT = "whatsapp.message";
export interface WhatsAppMessage {
  id: string;
  from: string;
  phoneNumberId: string;
  name?: string;
  text: string;
  timestamp: number;
  supported: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** Status receipts and messages for other business numbers never become agent turns. */
export function parseWhatsAppWebhook(payload: unknown, phoneNumberId: string): WhatsAppMessage[] {
  const root = object(payload);
  if (root?.object !== "whatsapp_business_account") return [];
  const messages: WhatsAppMessage[] = [];
  for (const entry of list(root.entry)) for (const change of list(object(entry)?.changes)) {
    if (object(change)?.field !== "messages") continue;
    const value = object(object(change)?.value);
    if (object(value?.metadata)?.phone_number_id !== phoneNumberId) continue;
    for (const item of list(value?.messages)) {
      const msg = object(item);
      const id = string(msg?.id);
      const from = string(msg?.from);
      const timestamp = Number(msg?.timestamp);
      if (!id || !from || !/^\d{7,15}$/.test(from) || !Number.isFinite(timestamp) || timestamp <= 0) continue;
      const interactive = object(msg?.interactive);
      const text = msg?.type === "text" ? string(object(msg.text)?.body)
        : msg?.type === "button" ? string(object(msg.button)?.text)
        : msg?.type === "interactive" ? string(object(interactive?.button_reply)?.title) ?? string(object(interactive?.list_reply)?.title)
        : undefined;
      const contact = list(value?.contacts).map(object).find((c) => c?.wa_id === from);
      messages.push({ id, from, phoneNumberId, text: text ?? "", timestamp, supported: Boolean(text), name: string(object(contact?.profile)?.name)?.slice(0, 100) });
    }
  }
  return messages;
}

export function whatsappEvent(message: WhatsAppMessage): Record<string, unknown> {
  return { type: WHATSAPP_MESSAGE_EVENT, message };
}

/** The gateway authenticates Meta; the agent additionally checks its own owner and business-number binding. */
export function parseWhatsAppEvent(event: unknown, ownerPhones: string[], phoneNumberId: string): InboundMessage | undefined {
  const root = object(event);
  const msg = object(root?.message);
  if (root?.type !== WHATSAPP_MESSAGE_EVENT || !msg || msg.phoneNumberId !== phoneNumberId) return undefined;
  const from = string(msg.from);
  const id = string(msg.id);
  const text = string(msg.text);
  const timestamp = Number(msg.timestamp);
  if (!from || !/^\d{7,15}$/.test(from) || !id || !text || text.length > 16_384 || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  if (!ownerPhones.some((phone) => phone.replace(/\D/g, "") === from)) return undefined;
  const receivedAt = new Date(timestamp * 1000);
  if (!Number.isFinite(receivedAt.getTime())) return undefined;
  return {
    id: `whatsapp:${phoneNumberId}:${id}`,
    channel: "whatsapp",
    conversationKey: `whatsapp:${phoneNumberId}:${from}`,
    from: `+${from}`,
    text,
    receivedAt: receivedAt.toISOString(),
    replyRef: { phoneNumberId, waId: from, messageId: id },
    source: "whatsapp",
  };
}
