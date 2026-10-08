import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One signed-up person. Secrets (identity key, signing key) never leave the gateway process. */
export interface UserRecord {
  id: string;
  channel?: "inkbox" | "whatsapp";
  whatsappId?: string;
  whatsappPhoneNumberId?: string;
  whatsappRelayToken?: string;
  whatsappLastInboundAt?: number;
  whatsappUsage?: { day: string; messages: number; eventIds: string[] };
  whatsappReplyUsage?: { day: string; messages: number; eventIds: string[] };
  whatsappDeleteRequestedAt?: number;
  whatsappAccess?: { kind: "existing" | "bootstrap" | "referral"; grantedAt: string; referrerId?: string };
  whatsappLoggedOutAt?: number;
  /** A stable bearer invitation; recipient hashes retain the lifetime five-person limit after deletion. */
  whatsappReferral?: { token: string; recipients: string[] };
  name: string;
  phone: string;
  email?: string;
  handle: string;
  identityId: string;
  identityApiKey: string;
  signingKey: string;
  /** Signing key returned by the webhook subscription, when Inkbox hands one back. Tried after `signingKey`. */
  webhookSigningKey?: string;
  webhookSubscriptionId?: string;
  maritimeAgentId?: string;
  maritimeProjectId?: string;
  createdAt: string;
  updatedAt?: string;
  status: "provisioning" | "ready" | "error" | "deleting";
  error?: string;
}

interface StoreFile {
  version: 1;
  users: UserRecord[];
  metadata?: StoreMetadata;
}

export interface StoreMetadata {
  /** One-time migration: later accounts must earn access through bootstrap or a referral. */
  whatsappAccessMigratedAt?: string;
  /** Sender-keyed lifetime quota survives deleting and recreating an inviter's account. */
  whatsappReferralLedgers?: Record<string, { issuerId: string; token: string; recipients: string[] }>;
}

/**
 * JSON-file user store. The file holds API keys, so it is written with 0600
 * permissions through a temp file and rename, which keeps a crash from leaving
 * a half-written file behind.
 */
export class UserStore {
  readonly dir: string;
  readonly file: string;
  private cache: Map<string, UserRecord> | undefined;
  private metadata: StoreMetadata = {};

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "users.json");
  }

  all(): UserRecord[] {
    return [...this.load().values()].map(clone);
  }

  readMetadata(): StoreMetadata {
    this.load();
    return clone(this.metadata);
  }

  get(id: string): UserRecord | undefined {
    const u = this.load().get(id);
    return u ? clone(u) : undefined;
  }

  byHandle(handle: string): UserRecord | undefined {
    const h = handle.toLowerCase();
    for (const u of this.load().values()) if (u.handle.toLowerCase() === h) return clone(u);
    return undefined;
  }

  byIdentityId(identityId: string): UserRecord | undefined {
    for (const u of this.load().values()) if (u.identityId === identityId) return clone(u);
    return undefined;
  }

  byPhone(phone: string): UserRecord | undefined {
    for (const u of this.load().values()) if (u.phone === phone) return clone(u);
    return undefined;
  }

  byWhatsApp(waId: string, phoneNumberId: string): UserRecord | undefined {
    for (const u of this.load().values()) {
      if (u.channel === "whatsapp" && u.whatsappId === waId && u.whatsappPhoneNumberId === phoneNumberId) return clone(u);
    }
    return undefined;
  }

  save(u: UserRecord): UserRecord {
    const next = { ...clone(u), updatedAt: new Date().toISOString() };
    return this.transaction((users) => {
      users.set(next.id, next);
      return next;
    });
  }

  remove(id: string): boolean {
    if (!this.load().has(id)) return false;
    return this.transaction((users) => users.delete(id));
  }

  /** Synchronous single-process transaction. Failed writes never change the in-memory authorization state. */
  transaction<T>(change: (users: Map<string, UserRecord>, metadata: StoreMetadata) => T): T {
    const users = clone(this.load());
    const metadata = clone(this.metadata);
    const result = change(users, metadata);
    // Do not retain mutable references supplied by the callback.
    const committed = clone(users);
    const committedMetadata = clone(metadata);
    this.persist(committed, committedMetadata);
    this.cache = committed;
    this.metadata = committedMetadata;
    return clone(result);
  }

  private load(): Map<string, UserRecord> {
    if (this.cache) return this.cache;
    const map = new Map<string, UserRecord>();
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile | UserRecord[];
      const users = Array.isArray(parsed) ? parsed : parsed.users ?? [];
      for (const u of users) map.set(u.id, u);
      if (!Array.isArray(parsed)) this.metadata = parsed.metadata ?? {};
    }
    this.cache = map;
    return map;
  }

  private persist(users: Map<string, UserRecord>, metadata: StoreMetadata): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const body: StoreFile = { version: 1, users: [...users.values()], metadata };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    // Apply permissions before committing, so an error cannot leave disk committed but cache unchanged.
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Strip anything a browser or a log line must not see. The name and the
 * provisioning error text stay out too: the id can leak, and this JSON must not
 * turn a leaked id into a profile.
 */
export function publicUser(u: UserRecord): Record<string, unknown> {
  return {
    id: u.id,
    handle: u.handle,
    phoneMasked: maskPhone(u.phone),
    status: u.status,
    hasError: u.status === "error",
    hasAgent: Boolean(u.maritimeAgentId),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 2)}${"•".repeat(Math.max(0, phone.length - 6))}${phone.slice(-4)}`;
}
