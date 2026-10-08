import { statSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UserStore, maskPhone, publicUser } from "../src/store.js";
import { readyUser, tempDir } from "./helpers.js";

describe("UserStore", () => {
  it("round-trips records through a 0600 file", () => {
    const dir = tempDir();
    const store = new UserStore(dir);
    const saved = store.save(readyUser());
    expect(saved.updatedAt).toBeTruthy();
    const mode = statSync(store.file).mode & 0o777;
    expect(mode).toBe(0o600);

    const again = new UserStore(dir);
    expect(again.get("usr_test")?.handle).toBe("maria");
    expect(again.byHandle("MARIA")?.id).toBe("usr_test");
    expect(again.byIdentityId("idn_1")?.id).toBe("usr_test");
    expect(again.byPhone("+14155550123")?.id).toBe("usr_test");
    expect(again.all()).toHaveLength(1);
  });

  it("returns copies so callers cannot mutate the cache", () => {
    const store = new UserStore(tempDir());
    store.save(readyUser());
    const u = store.get("usr_test")!;
    u.handle = "hacked";
    expect(store.get("usr_test")?.handle).toBe("maria");
  });

  it("removes records and keeps the file valid json", () => {
    const store = new UserStore(tempDir());
    store.save(readyUser({ id: "a", handle: "a-handle" }));
    store.save(readyUser({ id: "b", handle: "b-handle", phone: "+14155550124" }));
    expect(store.remove("a")).toBe(true);
    expect(store.remove("a")).toBe(false);
    const parsed = JSON.parse(readFileSync(store.file, "utf8"));
    expect(parsed.users.map((u: { id: string }) => u.id)).toEqual(["b"]);
  });

  it("publicUser strips secrets, the name and the error text", () => {
    const pub = publicUser(readyUser({ status: "error", error: "Maritime 402: wallet empty for Maria" }));
    const text = JSON.stringify(pub);
    expect(text).not.toContain("ik_secret");
    expect(text).not.toContain("whsec_");
    expect(text).not.toContain("+14155550123");
    expect(text).not.toContain("Maria");
    expect(text).not.toContain("402");
    expect(pub["status"]).toBe("error");
    expect(pub["hasError"]).toBe(true);
    expect(publicUser(readyUser())["status"]).toBe("ready");
    expect(maskPhone("+14155550123")).toBe("+1••••••0123");
  });

  it("does not change cached records when a save or removal cannot be persisted", () => {
    const store = new UserStore(tempDir());
    store.save(readyUser());
    const blockedTemp = `${store.file}.${process.pid}.tmp`;
    mkdirSync(blockedTemp);
    expect(() => store.save(readyUser({ handle: "uncommitted" }))).toThrow();
    expect(() => store.remove("usr_test")).toThrow();
    expect(store.get("usr_test")?.handle).toBe("maria");
    expect(new UserStore(store.dir).get("usr_test")?.handle).toBe("maria");
    rmSync(blockedTemp, { recursive: true });
    store.save(readyUser({ handle: "committed" }));
    expect(store.get("usr_test")?.handle).toBe("committed");
  });

  it("commits multiple records and metadata together without leaking mutable transaction references", () => {
    const store = new UserStore(tempDir());
    const input = readyUser();
    const result = store.transaction((users, metadata) => {
      users.set(input.id, input);
      users.set("other", readyUser({ id: "other" }));
      metadata.whatsappAccessMigratedAt = "once";
      return input;
    });
    input.handle = "external-change";
    result.handle = "returned-change";
    expect(store.get("usr_test")?.handle).toBe("maria");
    const reloaded = new UserStore(store.dir);
    expect(reloaded.all()).toHaveLength(2);
    expect(reloaded.readMetadata().whatsappAccessMigratedAt).toBe("once");
  });

  it("rolls back records and metadata when a transaction callback throws", () => {
    const store = new UserStore(tempDir());
    store.save(readyUser());
    expect(() => store.transaction((users, metadata) => {
      users.delete("usr_test");
      metadata.whatsappAccessMigratedAt = "not-committed";
      throw new Error("abort");
    })).toThrow("abort");
    expect(store.get("usr_test")).toBeDefined();
    expect(store.readMetadata().whatsappAccessMigratedAt).toBeUndefined();
  });
});
