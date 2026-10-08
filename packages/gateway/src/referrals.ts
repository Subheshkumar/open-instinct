import { createHash, randomBytes } from "node:crypto";
import { UserStore, type StoreMetadata, type UserRecord } from "./store.js";

const CAPACITY = 5;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface WhatsAppReferralLink {
  token: string;
  remaining: number;
  capacity: 5;
}

export type WhatsAppReferralRedemption =
  | { status: "granted" | "already_authorized"; user: UserRecord; remaining?: number }
  | { status: "invalid" | "full" };

/** Invitation admission runs synchronously, before provisioning or any other await. Use one gateway replica. */
export class WhatsAppReferrals {
  constructor(private readonly store: UserStore, private readonly now: () => number = Date.now) {}

  hasAccess(user: UserRecord | undefined): boolean {
    return Boolean(user?.channel === "whatsapp" && user.whatsappId && user.whatsappPhoneNumberId && user.whatsappAccess && user.status !== "deleting");
  }

  /** Preserve members already using Rex once. Accounts added after this migration remain locked. */
  migrateExisting(): number {
    if (this.store.readMetadata().whatsappAccessMigratedAt !== undefined) return 0;
    return this.store.transaction((users, metadata) => {
      if (metadata.whatsappAccessMigratedAt !== undefined) return 0;
      const at = this.at();
      let count = 0;
      for (const [id, user] of users) {
        if (user.channel !== "whatsapp" || user.whatsappAccess) continue;
        users.set(id, { ...user, whatsappAccess: { kind: "existing", grantedAt: at }, updatedAt: at });
        count++;
      }
      metadata.whatsappAccessMigratedAt = at;
      return count;
    });
  }

  /** Only the gateway's configured owner allowlist may invoke this method. */
  grantBootstrap(candidate: UserRecord): UserRecord {
    return this.store.transaction((users) => {
      const user = accountForSender(users, candidate);
      if (!user || !validSender(user) || user.status === "deleting") throw new Error("Invalid WhatsApp bootstrap account");
      if (users.has(user.id) && this.hasAccess(user)) return user;
      const at = this.at();
      const granted: UserRecord = { ...user, whatsappAccess: { kind: "bootstrap", grantedAt: at }, updatedAt: at };
      users.set(granted.id, granted);
      return granted;
    });
  }

  ensureLink(candidate: UserRecord): WhatsAppReferralLink {
    return this.store.transaction((users, metadata) => {
      const user = users.get(candidate.id);
      if (!this.hasAccess(user)) throw new Error("Rex access is required to generate a referral");
      const key = senderKey(user!);
      metadata.whatsappReferralLedgers ??= {};
      let ledger = metadata.whatsappReferralLedgers[key];
      if (!ledger || ledger.issuerId !== user!.id) {
        // A deleted and recreated inviter gets a new token, never another five slots.
        ledger = { issuerId: user!.id, token: randomBytes(32).toString("base64url"), recipients: ledger?.recipients ?? [] };
        metadata.whatsappReferralLedgers[key] = ledger;
      }
      users.set(user!.id, { ...user!, whatsappReferral: { token: ledger.token, recipients: [...ledger.recipients] }, updatedAt: this.at() });
      return link(ledger);
    });
  }

  /** The business number is mandatory: a referral issued by another Rex endpoint cannot grant access here. */
  inspect(token: string, phoneNumberId: string): WhatsAppReferralLink | undefined {
    if (!TOKEN.test(token)) return undefined;
    const found = referralIssuer(new Map(this.store.all().map((user) => [user.id, user])), this.store.readMetadata(), token, phoneNumberId);
    if (!found || !this.hasAccess(found.issuer)) return undefined;
    return link(found.ledger);
  }

  redeem(token: string, candidate: UserRecord): WhatsAppReferralRedemption {
    if (!TOKEN.test(token) || !validSender(candidate)) return { status: "invalid" };
    return this.store.transaction((users, metadata) => {
      const user = accountForSender(users, candidate);
      if (!user || user.status === "deleting") return { status: "invalid" };
      // A member does not use an invitation's limited places merely by opening its JOIN command.
      if (users.has(user.id) && this.hasAccess(user)) return { status: "already_authorized", user };
      const found = referralIssuer(users, metadata, token, user.whatsappPhoneNumberId!);
      if (!found || !this.hasAccess(found.issuer)) return { status: "invalid" };
      const { issuer, ledger } = found;
      const recipient = senderKey(user);
      if (!ledger.recipients.includes(recipient)) {
        if (ledger.recipients.length >= CAPACITY) return { status: "full" };
        ledger.recipients.push(recipient);
      }
      const at = this.at();
      const granted: UserRecord = {
        ...user,
        whatsappAccess: { kind: "referral", grantedAt: at, referrerId: issuer.id },
        updatedAt: at,
      };
      users.set(issuer.id, { ...issuer, whatsappReferral: { token, recipients: [...ledger.recipients] }, updatedAt: at });
      users.set(granted.id, granted);
      return { status: "granted", user: granted, remaining: CAPACITY - ledger.recipients.length };
    });
  }

  private at(): string { return new Date(this.now()).toISOString(); }
}

function validSender(user: UserRecord): boolean {
  return Boolean(user.channel === "whatsapp" && user.whatsappId && user.whatsappPhoneNumberId);
}

function senderKey(user: UserRecord): string {
  return createHash("sha256").update(`rex-whatsapp-referral:${user.whatsappPhoneNumberId}:${user.whatsappId}`).digest("hex");
}

function accountForSender(users: Map<string, UserRecord>, candidate: UserRecord): UserRecord | undefined {
  if (!validSender(candidate)) return undefined;
  const found = [...users.values()].find((user) => user.channel === "whatsapp" && user.whatsappId === candidate.whatsappId && user.whatsappPhoneNumberId === candidate.whatsappPhoneNumberId);
  if (found) return found;
  // Never replace another identity if the caller supplied a colliding account id.
  return users.has(candidate.id) ? undefined : candidate;
}

function referralIssuer(users: Map<string, UserRecord>, metadata: StoreMetadata, token: string, phoneNumberId: string) {
  for (const [key, ledger] of Object.entries(metadata.whatsappReferralLedgers ?? {})) {
    if (ledger.token !== token) continue;
    const issuer = users.get(ledger.issuerId);
    if (issuer && validSender(issuer) && issuer.whatsappPhoneNumberId === phoneNumberId && senderKey(issuer) === key) return { issuer, ledger };
  }
  return undefined;
}

function link(ledger: { token: string; recipients: string[] }): WhatsAppReferralLink {
  return { token: ledger.token, remaining: CAPACITY - ledger.recipients.length, capacity: CAPACITY };
}
