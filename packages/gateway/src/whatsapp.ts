import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { StateDir } from "@open-instinct/core";
import { revokeUserConnections } from "@open-instinct/apps";
import { DurableInbox } from "@open-instinct/inkbox";
import { WhatsAppClient, secretMatches, whatsappEvent, type WhatsAppMessage } from "@open-instinct/whatsapp";
import { deleteUserAgent, newUserId, provisionUser } from "./provision.js";
import { relayGatewayEvent } from "./relay.js";
import type { GatewayOptions } from "./server.js";
import type { UserRecord } from "./store.js";
import { WhatsAppReferrals } from "./referrals.js";

export interface WhatsAppGatewayConfig {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  phoneNumberId: string;
  apiVersion: string;
  publicNumber?: string;
  /** Verified WhatsApp senders the operator allows to start the invitation tree. */
  bootstrapNumbers?: string[];
  /** Hard admission limits stored across gateway restarts. */
  messagesPerDay?: number;
  repliesPerDay?: number;
  maxUsers?: number;
  newUsersPerHour?: number;
  notificationTemplate?: string;
  templateLanguage?: string;
}

interface Outgoing { userId: string; generation: string; text: string; accountManagement?: boolean }
const uncertain = (message: string): Error => Object.assign(new Error(message), { name: "InboundUncertainError" });

/** One always-on WhatsApp front door; every sender owns exactly one private VM. Run a single replica. */
export class WhatsAppGateway {
  private readonly client: WhatsAppClient;
  private readonly inbox: DurableInbox<WhatsAppMessage>;
  private readonly outgoing: DurableInbox<Outgoing>;
  private readonly state: StateDir;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly referrals: WhatsAppReferrals;

  constructor(private readonly opts: GatewayOptions & { whatsapp: WhatsAppGatewayConfig }) {
    this.now = opts.now ?? Date.now;
    this.referrals = new WhatsAppReferrals(opts.store, this.now);
    this.referrals.migrateExisting();
    this.state = new StateDir(opts.store.dir);
    this.client = new WhatsAppClient({ ...opts.whatsapp, fetchImpl: opts.fetchImpl });
    this.outgoing = new DurableInbox({
      file: join(opts.store.dir, "whatsapp-outbox.json"),
      concurrency: 1,
      handle: async (item) => {
        const user = opts.store.get(item.userId);
        if (!user || user.status === "deleting" || user.whatsappRelayToken !== item.generation || (!item.accountManagement && !this.canChat(user))) return;
        if (!user.whatsappId) throw uncertain("Missing WhatsApp recipient");
        if (this.now() - (user.whatsappLastInboundAt ?? 0) < 24 * 60 * 60_000) {
          await this.client.sendText(user.whatsappId, item.text);
        } else if (opts.whatsapp.notificationTemplate) {
          await this.client.sendTemplate(user.whatsappId, item.text, opts.whatsapp.notificationTemplate, opts.whatsapp.templateLanguage ?? "en");
        } else {
          throw uncertain("WhatsApp reply window is closed and no notification template is configured");
        }
      },
      onError: (id, status) => opts.logger?.warn("whatsapp.send_pending", { id, status }),
    });
    this.inbox = new DurableInbox({
      file: join(opts.store.dir, "whatsapp-inbox.json"),
      replayRunning: true, // VM admission deduplicates by the original Meta message id.
      handle: (message) => this.serial(message.from, () => this.handle(message)),
      onError: (id, status) => opts.logger?.warn("whatsapp.message_pending", { id, status }),
    });
  }

  start(): void { this.inbox.start(); this.outgoing.start(); }
  stop(): void { this.inbox.stop(); }
  async close(): Promise<void> {
    await this.inbox.close();
    // Recovery jobs use the same sender locks but do not belong to the inbox.
    // Keep reply admission open until these handlers have persisted their notices.
    await Promise.allSettled([...this.locks.values()]);
    await this.outgoing.close();
  }
  summary(): Record<string, unknown> { return { incoming: this.inbox.summary(), outgoing: this.outgoing.summary() }; }
  admit(message: WhatsAppMessage): void { this.inbox.enqueue(`${message.phoneNumberId}:${message.id}`, message); }

  canChat(user: UserRecord | undefined): user is UserRecord {
    return Boolean(user && this.referrals.hasAccess(user) && user.whatsappLoggedOutAt === undefined);
  }

  referralInfo(token: string) { return this.referrals.inspect(token, this.opts.whatsapp.phoneNumberId); }

  /** Tokens are scoped to a user generation, never to a request-supplied recipient. */
  send(userId: string, token: string | undefined, body: unknown): { status: number; body: Record<string, unknown> } {
    const user = this.opts.store.get(userId);
    if (!user || user.channel !== "whatsapp" || !secretMatches(user.whatsappRelayToken ?? "", token)) return { status: 401, body: { error: "invalid relay token" } };
    if (user.status === "deleting") return { status: 410, body: { error: "account is being deleted" } };
    if (!this.canChat(user)) return { status: 403, body: { error: "Rex login required" } };
    const item = body as { id?: unknown; text?: unknown; to?: unknown } | null;
    if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || typeof item.text !== "string" || !item.text.trim() || item.text.length > 16_384 || item.to !== undefined) {
      return { status: 400, body: { error: "expected { id, text }; recipient is fixed to the account owner" } };
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const usage = user.whatsappReplyUsage?.day === day ? user.whatsappReplyUsage : { day, messages: 0, eventIds: [] };
    if (!usage.eventIds.includes(item.id) && usage.messages >= (this.opts.whatsapp.repliesPerDay ?? 300)) return { status: 429, body: { error: "daily reply limit reached" } };
    if (!usage.eventIds.includes(item.id)) {
      usage.messages++;
      usage.eventIds.push(item.id);
      this.opts.store.save({ ...user, whatsappReplyUsage: usage });
    }
    const fresh = this.outgoing.enqueue(`${user.id}:${item.id}`, { userId: user.id, generation: user.whatsappRelayToken!, text: item.text });
    return { status: 202, body: { accepted: true, duplicate: !fresh } };
  }

  resumePending(): number {
    const users = this.opts.store.all().filter((u) => u.channel === "whatsapp" && (u.status === "deleting" || (u.status === "provisioning" && this.canChat(u))));
    for (const user of users) void this.serial(user.whatsappId!, async () => {
      const current = this.opts.store.get(user.id);
      if (!current) return;
      if (current.status === "deleting") await this.deleteAccount(current);
      else if (this.canChat(current)) await this.provision(current);
    }).catch(() => this.opts.logger?.warn("whatsapp.resume_failed", { userId: user.id }));
    return users.length;
  }

  private async serial(key: string, run: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.locks.set(key, next);
    try { await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }

  private async provision(user: UserRecord): Promise<UserRecord> {
    if (!this.canChat(this.opts.store.get(user.id))) throw new Error("Rex login required");
    return provisionUser(user, { ...this.opts, userId: user.id });
  }

  private deletionKey(from: string): string {
    return createHash("sha256").update(`${this.opts.whatsapp.phoneNumberId}:${from}`).digest("hex");
  }

  private async handle(message: WhatsAppMessage): Promise<void> {
    const deleted = this.state.readJson<Record<string, number>>("whatsapp-deletions.json", {});
    if (message.timestamp * 1000 <= (deleted[this.deletionKey(message.from)] ?? 0)) return;
    // Ignore stale replays and reject future timestamps; neither may reopen a reply window.
    if (message.timestamp * 1000 > this.now() + 300_000 || this.now() - message.timestamp * 1000 > 24 * 60 * 60_000) return;
    let user = this.opts.store.byWhatsApp(message.from, message.phoneNumberId);
    const text = message.text.trim();
    const join = /^join\s+([A-Za-z0-9_-]{43})$/i.exec(text);
    if (!user && /^delete my account$/i.test(text)) {
      await this.client.sendText(message.from, "You do not have a Rex account.");
      return;
    }
    if (user?.status === "deleting") { await this.deleteAccount(user); return; }
    const managingAccount = Boolean(user) && /^(delete my account|DELETE|CANCEL)$/i.test(text);
    if (!this.referrals.hasAccess(user) && !managingAccount) {
      const bootstrap = this.opts.whatsapp.bootstrapNumbers?.some((number) => number.replace(/\D/g, "") === message.from);
      if (!join && !bootstrap) {
        await this.client.sendText(message.from, "Rex is invite-only. Ask a member for their referral link, open it, and send the prefilled JOIN message here to log in.");
        return;
      }
      if (!message.supported || text.length > 8000) {
        await this.client.sendText(message.from, "Please send a text message of up to 8000 characters to start using Rex.");
        return;
      }
      const all = this.opts.store.all().filter((u) => u.channel === "whatsapp");
      const recent = this.state.readJson<number[]>("whatsapp-signups.json", []).filter((at) => at > this.now() - 3600_000);
      if (!user && (all.length >= (this.opts.whatsapp.maxUsers ?? 100) || recent.length >= (this.opts.whatsapp.newUsersPerHour ?? 20))) {
        await this.client.sendText(message.from, "Rex is at capacity for new accounts. Please try again later.");
        return;
      }
      const isNew = !user;
      const id = user?.id ?? newUserId();
      const candidate: UserRecord = user ?? {
        id, channel: "whatsapp", name: message.name ?? "WhatsApp user", phone: `+${message.from}`, handle: `rex-${id.slice(4)}`,
        whatsappId: message.from, whatsappPhoneNumberId: message.phoneNumberId, whatsappRelayToken: randomBytes(32).toString("hex"),
        identityId: "", identityApiKey: "", signingKey: "", createdAt: new Date(this.now()).toISOString(), status: "provisioning",
      };
      if (bootstrap) user = this.referrals.grantBootstrap(candidate);
      else {
        const result = this.referrals.redeem(join![1]!, candidate);
        if (!("user" in result)) {
          await this.client.sendText(message.from, result.status === "full" ? "This referral has already invited five people. Ask another Rex member for a referral link." : "This referral link is not valid. Ask a Rex member for a new link.");
          return;
        }
        user = result.user;
      }
      if (isNew) {
        this.state.writeJson("whatsapp-signups.json", [...recent, this.now()]);
        this.opts.logger?.info("whatsapp.user_created", { userId: id });
      }
    }
    if (!user) return;
    user = this.opts.store.save({ ...user, whatsappLastInboundAt: Math.max(user.whatsappLastInboundAt ?? 0, message.timestamp * 1000) });
    if (user.status === "deleting") { await this.deleteAccount(user); return; }
    if (/^delete my account$/i.test(text)) {
      this.opts.store.save({ ...user, whatsappDeleteRequestedAt: this.now() });
      this.notice(user, "Reply DELETE within 10 minutes to delete your Rex agent, memory, files and connected-account credentials. Reply CANCEL to keep your account.", message.id, true);
      return;
    }
    if (user.whatsappDeleteRequestedAt !== undefined) {
      if (text === "DELETE" && this.now() - user.whatsappDeleteRequestedAt <= 600_000) {
        user = this.opts.store.save({ ...user, status: "deleting" });
        await this.deleteAccount(user);
        return;
      }
      user = this.opts.store.save({ ...user, whatsappDeleteRequestedAt: undefined });
      if (/^cancel$/i.test(text)) { this.notice(user, "Your Rex account has been kept.", message.id, true); return; }
    }
    if (/^logout$/i.test(text) && this.referrals.hasAccess(user)) {
      this.opts.store.save({ ...user, whatsappLoggedOutAt: this.now() });
      const loggedOutId = user.id;
      this.outgoing.removeQueued((item) => item.userId === loggedOutId);
      await this.client.sendText(message.from, "You are logged out of Rex. Send LOGIN from this WhatsApp account to log in again.");
      return;
    }
    if (/^login$/i.test(text) || join) {
      if (!this.referrals.hasAccess(user)) return;
      user = this.opts.store.save({ ...user, whatsappLoggedOutAt: undefined });
      if (user.status !== "ready") user = await this.provision(user);
      this.notice(user, "You are logged in to Rex. Send a message to start chatting, or send REFERRAL to invite up to five people.", message.id);
      return;
    }
    if (!this.canChat(user)) {
      await this.client.sendText(message.from, this.referrals.hasAccess(user) ? "You are logged out of Rex. Send LOGIN to continue." : "Rex is invite-only. Ask a member for a referral link to log in.");
      return;
    }
    if (/^(referral|referral link|invite|invite friends|get referral link)$/i.test(text)) {
      const referral = this.referrals.ensureLink(user);
      const url = `${this.opts.publicUrl.replace(/\/+$/, "")}/invite/${referral.token}`;
      this.notice(user, `Your Rex referral link:\n${url}\n\n${referral.remaining} of ${referral.capacity} invitations remaining. Share this link with friends. Each person must send the JOIN message from their own WhatsApp account.`, message.id);
      return;
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const usage = user.whatsappUsage?.day === day ? user.whatsappUsage : { day, messages: 0, eventIds: [] };
    if (!usage.eventIds.includes(message.id)) {
      if (usage.messages >= (this.opts.whatsapp.messagesPerDay ?? 100)) {
        // A deterministic notice id prevents duplicate limit messages within the day.
        this.notice(user, "You have reached your daily Rex message limit. It resets at midnight UTC.", `limit-${day}`);
        return;
      }
      usage.messages++;
      usage.eventIds.push(message.id);
      user = this.opts.store.save({ ...this.opts.store.get(user.id)!, whatsappUsage: usage });
    }
    if (!message.supported || text.length > 8000) {
      this.notice(user, "For now, Rex accepts text messages of up to 8000 characters.", message.id);
      return;
    }
    if (user.status !== "ready") user = await this.provision(user);
    if (!this.canChat(this.opts.store.get(user.id))) return;
    const result = await relayGatewayEvent(user, whatsappEvent(message), `whatsapp:${message.phoneNumberId}:${message.from}`, {
      maritime: this.opts.maritime, fetchImpl: this.opts.fetchImpl, logger: this.opts.logger,
    });
    if (result.status !== "forwarded") throw new Error("WhatsApp agent admission failed");
  }

  private notice(user: UserRecord, text: string, id: string, accountManagement = false): void {
    this.outgoing.enqueue(`${user.id}:notice:${id}`, { userId: user.id, generation: user.whatsappRelayToken!, text, accountManagement });
  }

  private async deleteAccount(user: UserRecord): Promise<void> {
    // If a create timed out, recover its externalId before deleting so no orphan VM remains.
    await deleteUserAgent(user, this.opts);
    if (this.opts.revokeAppsForUser) await this.opts.revokeAppsForUser(user);
    else if (this.opts.composioApiKey) await revokeUserConnections(this.opts.composioApiKey, user.handle);
    const deleted = this.state.readJson<Record<string, number>>("whatsapp-deletions.json", {});
    deleted[this.deletionKey(user.whatsappId!)] = this.now();
    this.state.writeJson("whatsapp-deletions.json", deleted);
    this.inbox.removeQueued((message) => message.from === user.whatsappId);
    this.outgoing.removeQueued((item) => item.userId === user.id);
    this.opts.store.remove(user.id);
    this.opts.logger?.info("whatsapp.user_deleted", { userId: user.id });
    await this.client.sendText(user.whatsappId!, "Your Rex account and private agent have been deleted. Use a valid referral link to create a new account.");
  }
}
