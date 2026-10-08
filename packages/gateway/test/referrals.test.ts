import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WhatsAppReferrals } from "../src/referrals.js";
import { UserStore, type UserRecord } from "../src/store.js";
import { readyUser, tempDir } from "./helpers.js";

const NOW = Date.parse("2026-10-08T10:00:00.000Z");

function whatsappUser(id: string, overrides: Partial<UserRecord> = {}): UserRecord {
  return readyUser({
    id, channel: "whatsapp", whatsappId: id === "owner" ? "919800000000" : `9198000000${id.replace(/\D/g, "").padStart(2, "0")}`,
    whatsappPhoneNumberId: "123456789", handle: `rex-${id}`, status: "provisioning", maritimeAgentId: undefined,
    ...overrides,
  });
}

function setup() {
  const store = new UserStore(tempDir());
  const referrals = new WhatsAppReferrals(store, () => NOW);
  referrals.migrateExisting();
  const owner = referrals.grantBootstrap(whatsappUser("owner"));
  return { store, referrals, owner };
}

describe("WhatsAppReferrals", () => {
  it("migrates existing WhatsApp members only once across restarts", () => {
    const store = new UserStore(tempDir());
    store.save(whatsappUser("owner"));
    store.save(readyUser({ id: "inkbox" }));
    const referrals = new WhatsAppReferrals(store, () => NOW);
    expect(referrals.migrateExisting()).toBe(1);
    expect(store.get("owner")?.whatsappAccess).toEqual({ kind: "existing", grantedAt: new Date(NOW).toISOString() });
    expect(store.get("inkbox")?.whatsappAccess).toBeUndefined();
    store.save(whatsappUser("u1"));
    const reloaded = new WhatsAppReferrals(new UserStore(store.dir), () => NOW + 1000);
    expect(reloaded.migrateExisting()).toBe(0);
    expect(referrals.hasAccess(store.get("u1"))).toBe(false);
  });

  it("does not grant migration access or cache its marker when persistence fails", () => {
    const store = new UserStore(tempDir());
    store.save(whatsappUser("owner"));
    const referrals = new WhatsAppReferrals(store, () => NOW);
    const blocked = `${store.file}.${process.pid}.tmp`;
    mkdirSync(blocked);
    expect(() => referrals.migrateExisting()).toThrow();
    expect(referrals.hasAccess(store.get("owner"))).toBe(false);
    expect(store.readMetadata().whatsappAccessMigratedAt).toBeUndefined();
    rmSync(blocked, { recursive: true });
    expect(referrals.migrateExisting()).toBe(1);
  });

  it("grants bootstrap membership but preserves an existing member's provenance", () => {
    const { store, referrals, owner } = setup();
    expect(owner.whatsappAccess?.kind).toBe("bootstrap");
    const at = owner.whatsappAccess?.grantedAt;
    expect(referrals.grantBootstrap(owner).whatsappAccess?.grantedAt).toBe(at);
    expect(referrals.hasAccess(store.get(owner.id))).toBe(true);
    expect(() => referrals.grantBootstrap(readyUser())).toThrow("Invalid WhatsApp bootstrap account");
  });

  it("generates a stable high-entropy link only for authorized current accounts", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    expect(invite).toMatchObject({ capacity: 5, remaining: 5 });
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(referrals.ensureLink(owner)).toEqual(invite);
    const reload = new WhatsAppReferrals(new UserStore(store.dir), () => NOW);
    expect(reload.ensureLink(owner)).toEqual(invite);
    expect(() => referrals.ensureLink(whatsappUser("u1"))).toThrow("Rex access is required");
    store.save({ ...store.get(owner.id)!, status: "deleting" });
    expect(() => referrals.ensureLink(owner)).toThrow("Rex access is required");
  });

  it("stores the new user's grant and invitation claim together", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    const result = referrals.redeem(invite.token, whatsappUser("u1"));
    expect(result).toMatchObject({ status: "granted", remaining: 4, user: { id: "u1", whatsappAccess: { kind: "referral", referrerId: owner.id } } });
    const reloaded = new UserStore(store.dir);
    expect(referrals.hasAccess(reloaded.get("u1"))).toBe(true);
    expect(reloaded.get(owner.id)?.whatsappReferral?.recipients).toHaveLength(1);
    const contents = readFileSync(store.file, "utf8");
    const ledger = reloaded.readMetadata().whatsappReferralLedgers!;
    expect(Object.keys(ledger)[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(ledger)[0]?.recipients[0]).toMatch(/^[a-f0-9]{64}$/);
    // User records hold routing IDs, but the quota ledger does not duplicate personal numbers.
    expect(JSON.stringify(ledger)).not.toContain(whatsappUser("u1").whatsappId);
    expect(contents).toContain('"referrerId": "owner"');
  });

  it("admits five distinct senders and rejects a sixth without creating their record", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    for (let i = 1; i <= 5; i++) expect(referrals.redeem(invite.token, whatsappUser(`u${i}`)).status).toBe("granted");
    expect(referrals.redeem(invite.token, whatsappUser("u6"))).toEqual({ status: "full" });
    expect(store.get("u6")).toBeUndefined();
    expect(referrals.inspect(invite.token, "123456789")?.remaining).toBe(0);
  });

  it("makes retries and different candidate IDs for the same sender idempotent", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    const person = whatsappUser("u1");
    expect(referrals.redeem(invite.token, person).status).toBe("granted");
    expect(referrals.redeem(invite.token, person).status).toBe("already_authorized");
    expect(referrals.redeem(invite.token, { ...person, id: "retry-id" })).toMatchObject({ status: "already_authorized", user: { id: person.id } });
    expect(store.get("retry-id")).toBeUndefined();
    expect(referrals.inspect(invite.token, "123456789")?.remaining).toBe(4);
  });

  it("does not spend an invitation slot on an existing member", () => {
    const { referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    const member = referrals.grantBootstrap(whatsappUser("u1"));
    expect(referrals.redeem(invite.token, member).status).toBe("already_authorized");
    expect(referrals.redeem(invite.token, owner).status).toBe("already_authorized");
    expect(referrals.inspect(invite.token, "123456789")?.remaining).toBe(5);
  });

  it("does not refund places when recipients delete and permits the same counted sender to rejoin", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    for (let i = 1; i <= 5; i++) referrals.redeem(invite.token, whatsappUser(`u${i}`));
    store.remove("u1");
    expect(referrals.inspect(invite.token, "123456789")?.remaining).toBe(0);
    expect(referrals.redeem(invite.token, whatsappUser("u6"))).toEqual({ status: "full" });
    expect(referrals.redeem(invite.token, whatsappUser("u1", { id: "u1-returned" }))).toMatchObject({ status: "granted", remaining: 0 });
  });

  it("preserves an inviter's lifetime quota after deletion and rotates their old link on rejoin", () => {
    const { store, referrals, owner } = setup();
    const oldLink = referrals.ensureLink(owner);
    for (let i = 1; i <= 5; i++) referrals.redeem(oldLink.token, whatsappUser(`u${i}`));
    store.remove(owner.id);
    expect(referrals.inspect(oldLink.token, "123456789")).toBeUndefined();
    expect(referrals.hasAccess(store.get("u1"))).toBe(true);
    const rejoined = referrals.grantBootstrap({ ...owner, id: "owner-returned", whatsappReferral: undefined, whatsappAccess: undefined });
    const nextLink = referrals.ensureLink(rejoined);
    expect(nextLink.token).not.toBe(oldLink.token);
    expect(nextLink.remaining).toBe(0);
    expect(referrals.inspect(oldLink.token, "123456789")).toBeUndefined();
    expect(referrals.redeem(nextLink.token, whatsappUser("u6"))).toEqual({ status: "full" });
  });

  it("binds links to the business number and rejects missing, malformed, or unknown links", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    expect(referrals.inspect(invite.token, "other-business")).toBeUndefined();
    expect(referrals.redeem(invite.token, whatsappUser("u1", { whatsappPhoneNumberId: "other-business" }))).toEqual({ status: "invalid" });
    expect(referrals.redeem("bad", whatsappUser("u1"))).toEqual({ status: "invalid" });
    expect(referrals.redeem("a".repeat(43), whatsappUser("u1"))).toEqual({ status: "invalid" });
    expect(referrals.redeem(invite.token, readyUser({ id: "inkbox" }))).toEqual({ status: "invalid" });
    expect(store.all()).toHaveLength(1);
  });

  it("rejects deleted or deleting issuers and recipients", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    expect(referrals.redeem(invite.token, whatsappUser("u1", { status: "deleting" }))).toEqual({ status: "invalid" });
    store.save({ ...store.get(owner.id)!, status: "deleting" });
    expect(referrals.inspect(invite.token, "123456789")).toBeUndefined();
    expect(referrals.redeem(invite.token, whatsappUser("u1"))).toEqual({ status: "invalid" });
    store.remove(owner.id);
    expect(referrals.redeem(invite.token, whatsappUser("u1"))).toEqual({ status: "invalid" });
  });

  it("keeps membership and issued invitations when a member logs out", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    store.save({ ...store.get(owner.id)!, whatsappLoggedOutAt: NOW });
    expect(referrals.hasAccess(store.get(owner.id))).toBe(true);
    expect(referrals.inspect(invite.token, "123456789")).toEqual(invite);
  });

  it("rolls back a failed redemption completely and can safely retry", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    const before = readFileSync(store.file, "utf8");
    const blocked = `${store.file}.${process.pid}.tmp`;
    mkdirSync(blocked);
    expect(() => referrals.redeem(invite.token, whatsappUser("u1"))).toThrow();
    expect(store.get("u1")).toBeUndefined();
    expect(referrals.inspect(invite.token, "123456789")?.remaining).toBe(5);
    expect(readFileSync(store.file, "utf8")).toBe(before);
    rmSync(blocked, { recursive: true });
    expect(referrals.redeem(invite.token, whatsappUser("u1"))).toMatchObject({ status: "granted", remaining: 4 });
  });

  it("does not cache a generated link or bootstrap grant when persistence fails", () => {
    const { store, referrals, owner } = setup();
    const blocked = `${store.file}.${process.pid}.tmp`;
    mkdirSync(blocked);
    expect(() => referrals.ensureLink(owner)).toThrow();
    expect(store.get(owner.id)?.whatsappReferral).toBeUndefined();
    expect(store.readMetadata().whatsappReferralLedgers).toBeUndefined();
    expect(() => referrals.grantBootstrap(whatsappUser("u1"))).toThrow();
    expect(store.get("u1")).toBeUndefined();
    rmSync(blocked, { recursive: true });
    expect(referrals.ensureLink(owner).remaining).toBe(5);
  });

  it("never replaces another sender through a colliding account ID", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    const collision = whatsappUser("u1", { id: owner.id });
    expect(referrals.redeem(invite.token, collision)).toEqual({ status: "invalid" });
    expect(store.get(owner.id)?.whatsappId).toBe(owner.whatsappId);
    expect(referrals.inspect(invite.token, "123456789")?.remaining).toBe(5);
  });

  it("treats the persistent ledger as authoritative after an unrelated stale account save", () => {
    const { store, referrals, owner } = setup();
    const invite = referrals.ensureLink(owner);
    const snapshot = store.get(owner.id)!;
    for (let i = 1; i <= 5; i++) referrals.redeem(invite.token, whatsappUser(`u${i}`));
    store.save(snapshot);
    expect(referrals.inspect(invite.token, "123456789")?.remaining).toBe(0);
    expect(referrals.redeem(invite.token, whatsappUser("u6"))).toEqual({ status: "full" });
    expect(referrals.ensureLink(owner).remaining).toBe(0);
  });
});
