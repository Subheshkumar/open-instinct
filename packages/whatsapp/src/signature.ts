import { createHmac, timingSafeEqual } from "node:crypto";

export function secretMatches(expected: string, presented: string | undefined): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authenticate the exact request bytes, before parsing or trusting sender ids. */
export function verifyWhatsAppSignature(raw: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!appSecret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return secretMatches(`sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`, signature);
}
