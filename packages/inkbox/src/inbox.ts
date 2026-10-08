import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Status = "queued" | "running" | "done" | "uncertain";
interface Receipt<T> {
  id: string;
  status: Status;
  payload?: T;
  attempts: number;
  nextAttemptAt: number;
}

export interface DurableInboxOptions<T> {
  file: string;
  handle(payload: T): Promise<void>;
  now?: () => number;
  retryMs?: number;
  concurrency?: number;
  maxPending?: number;
  /** Only enable when repeating the handler is idempotent across process restarts. */
  replayRunning?: boolean;
  onError?(id: string, status: "queued" | "uncertain"): void;
}

/** Single-process receipt store. Admission reaches disk before the caller acknowledges. */
export class DurableInbox<T> {
  private readonly rows: Map<string, Receipt<T>>;
  private readonly active = new Set<Promise<void>>();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private closed = false;

  constructor(private readonly opts: DurableInboxOptions<T>) {
    this.now = opts.now ?? Date.now;
    const saved = existsSync(opts.file) ? JSON.parse(readFileSync(opts.file, "utf8")) as { version: number; receipts: Receipt<T>[] } : { version: 1, receipts: [] };
    if (saved.version !== 1 || !Array.isArray(saved.receipts)) throw new Error("Invalid webhook inbox state");
    this.rows = new Map(saved.receipts.map((row) => {
      if (!row.id || !["queued", "running", "done", "uncertain"].includes(row.status)) throw new Error("Invalid webhook receipt");
      // An interrupted handler may already have performed external actions.
      return [row.id, { ...row, status: row.status === "running" ? (opts.replayRunning ? "queued" : "uncertain") : row.status }];
    }));
  }

  enqueue(id: string, payload: T): boolean {
    if (this.closed) throw new Error("Webhook inbox is closed");
    if (this.rows.has(id)) return false;
    if (!id) throw new Error("Webhook event id is required");
    const pending = [...this.rows.values()].filter((row) => row.status !== "done").length;
    if (pending >= (this.opts.maxPending ?? 5000)) throw new Error("Webhook inbox is full");
    this.rows.set(id, { id, payload: structuredClone(payload), status: "queued", attempts: 0, nextAttemptAt: this.now() });
    try {
      this.persist();
    } catch (err) {
      this.rows.delete(id);
      throw err;
    }
    this.schedule();
    return true;
  }

  start(): void {
    if (this.closed) throw new Error("Webhook inbox is closed");
    this.started = true;
    this.schedule();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Finish only handlers already running. Leave queued receipts for the next process. */
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.active]);
  }

  summary(): Record<Status, number> {
    const result = { queued: 0, running: 0, done: 0, uncertain: 0 };
    for (const row of this.rows.values()) result[row.status]++;
    return result;
  }

  /** Account deletion can discard queued payloads; already-running work must settle before it is removed. */
  removeQueued(predicate: (payload: T) => boolean): number {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if ((row.status === "queued" || row.status === "uncertain") && row.payload !== undefined && predicate(row.payload)) {
        this.rows.delete(id);
        removed++;
      }
    }
    if (removed) this.persist();
    return removed;
  }

  /** Run due receipts; future retry times remain queued. Useful during shutdown and tests. */
  async drain(): Promise<void> {
    for (;;) {
      this.pump();
      if (!this.active.size) return;
      await Promise.all([...this.active]);
    }
  }

  private schedule(): void {
    if (!this.started || this.closed || this.timer || this.active.size >= (this.opts.concurrency ?? 8)) return;
    const next = Math.min(...[...this.rows.values()].filter((r) => r.status === "queued").map((r) => r.nextAttemptAt));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, Math.max(0, Math.min(next - this.now(), 2_147_483_647)));
    this.timer.unref();
  }

  private pump(): void {
    if (this.closed) return;
    for (const row of this.rows.values()) {
      if (this.active.size >= (this.opts.concurrency ?? 8)) break;
      if (row.status !== "queued" || row.nextAttemptAt > this.now()) continue;
      // Mark synchronously before yielding so concurrent drains cannot start it twice.
      row.status = "running";
      const work = this.run(row).finally(() => {
        this.active.delete(work);
        this.schedule();
      });
      this.active.add(work);
    }
    this.schedule();
  }

  private async run(row: Receipt<T>): Promise<void> {
    const payload = row.payload;
    let executed = false;
    try {
      row.attempts++;
      this.persist();
      if (payload === undefined) throw new Error("Webhook receipt has no payload");
      await this.opts.handle(payload);
      executed = true;
      row.status = "done";
      delete row.payload;
      this.persist();
    } catch (err) {
      // An interrupted model turn or an unrecorded outcome is not safe to execute again.
      row.status = executed || (err instanceof Error && err.name === "InboundUncertainError") ? "uncertain" : "queued";
      row.payload = payload;
      row.nextAttemptAt = this.now() + Math.min(300_000, (this.opts.retryMs ?? 5000) * 2 ** Math.min(row.attempts - 1, 6));
      try { this.persist(); } catch { /* Leave the last durable admission for restart recovery. */ }
      this.opts.onError?.(row.id, row.status);
    }
  }

  private persist(): void {
    const completed = [...this.rows.values()].filter((r) => r.status === "done");
    for (const row of completed.slice(0, Math.max(0, completed.length - 5000))) this.rows.delete(row.id);
    const dir = dirname(this.opts.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.opts.file}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, receipts: [...this.rows.values()] }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.opts.file);
    const directory = openSync(dir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
