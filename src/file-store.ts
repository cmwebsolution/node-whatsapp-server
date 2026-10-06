import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  open,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { Vault } from "./crypto.js";
import { ApiError } from "./errors.js";
import {
  keyFor,
  type Store,
  type Lease,
  type State,
  type Submission,
} from "./store-contract.js";
import type { StatusEvent, EventPage, SnapshotPage } from "./events.js";

type Row = {
  app: string;
  user: string;
  generation: number;
  owner?: string;
  until: number;
  enabled: boolean;
  status: State;
  phone: string | null;
  revision: string;
  auth: Record<string, string>;
  submissions: Record<
    string,
    Submission & { created: number; generation: number }
  >;
  events: StatusEvent[];
  floor?: string;
};
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    const directory = await open(resolve(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
export class FileStore implements Store {
  private rows = new Map<string, Row>();
  private queue: Promise<unknown> = Promise.resolve();
  private vault!: Vault;
  private sequence = 0n;
  private locked = false;
  private failed = false;
  constructor(
    public root = resolve(process.env.DATA_DIR ?? "data"),
    private mediaLimit = 2,
  ) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue
      .catch(() => {})
      .then(() => {
        if (!this.locked || this.failed) throw new Error("Storage unavailable");
        return fn();
      });
    this.queue = next;
    return next;
  }
  async ready(): Promise<void> {
    if (this.failed) throw new Error("Storage unavailable");
    if (this.locked) return;
    await mkdir(join(this.root, "sessions"), { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await chmod(join(this.root, "sessions"), 0o700);
    const ownerLock = join(this.root, ".owner-lock");
    try {
      await mkdir(ownerLock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recovery = join(this.root, ".recovery-lock");
      await mkdir(recovery, { mode: 0o700 });
      try {
        const owner = JSON.parse(
          await readFile(join(ownerLock, "owner.json"), "utf8"),
        );
        if (!Number.isInteger(owner.pid) || owner.pid < 1)
          throw new Error("Invalid storage owner");
        let dead = false;
        try {
          process.kill(owner.pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") dead = true;
          else throw probe;
        }
        if (!dead)
          throw new Error("Storage already owned by a running process");
        await rm(ownerLock, { recursive: true });
        await mkdir(ownerLock, { mode: 0o700 });
      } finally {
        await rm(recovery, { recursive: true, force: true });
      }
    }
    this.locked = true;
    try {
      await atomicJson(join(this.root, ".owner-lock", "owner.json"), {
        pid: process.pid,
      });
      let key: string;
      try {
        key = JSON.parse(
          await readFile(join(this.root, "encryption-key.json"), "utf8"),
        ).v1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (
          (await readdir(join(this.root, "sessions"))).some((name) =>
            name.endsWith(".json"),
          )
        )
          throw new Error("Existing sessions require their encryption key");
        key = randomBytes(32).toString("base64");
        await atomicJson(join(this.root, "encryption-key.json"), { v1: key });
      }
      if (!/^[A-Za-z0-9+/]{43}=$/.test(key))
        throw new Error("Invalid storage encryption key");
      this.vault = new Vault({ v1: Buffer.from(key, "base64") }, "v1");
      for (const name of await readdir(join(this.root, "sessions"))) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const row: Row = JSON.parse(
          await readFile(join(this.root, "sessions", name), "utf8"),
        );
        if (keyFor(row.app, row.user) !== name.slice(0, -5))
          throw new Error("Invalid session storage");
        for (const event of row.events)
          this.sequence =
            this.sequence > BigInt(event.sequence)
              ? this.sequence
              : BigInt(event.sequence);
        row.owner = undefined;
        row.until = 0;
        this.rows.set(name.slice(0, -5), row);
      }
      this.sequence =
        this.sequence > BigInt(Date.now()) * 1000n
          ? this.sequence
          : BigInt(Date.now()) * 1000n;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    await this.queue.catch(() => {});
    if (this.locked) {
      this.locked = false;
      await rm(join(this.root, ".owner-lock"), {
        recursive: true,
        force: true,
      });
    }
  }
  async credentials(): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(
        await readFile(join(this.root, "applications.json"), "utf8"),
      );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([app, hash]) =>
            !/^[A-Za-z0-9_-]{1,100}$/.test(app) ||
            typeof hash !== "string" ||
            !/^[a-f0-9]{64}$/.test(hash),
        )
      )
        throw new Error("Invalid application registry");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  async provision(app: string, token: string): Promise<void> {
    await this.serial(async () => {
      const credentials = await this.credentials();
      const hash = createHash("sha256").update(token).digest("hex");
      if (
        Object.hasOwn(credentials, app) ||
        Object.values(credentials).includes(hash)
      )
        throw new Error("Application or token already exists");
      Object.defineProperty(credentials, app, {
        value: hash,
        enumerable: true,
        writable: true,
      });
      await atomicJson(join(this.root, "applications.json"), credentials);
    });
  }
  private async save(id: string, row: Row): Promise<void> {
    try {
      await atomicJson(join(this.root, "sessions", `${id}.json`), row);
      this.rows.set(id, row);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  private fence(l: Lease): Row {
    const row = this.rows.get(l.id);
    if (
      !row ||
      row.owner !== l.owner ||
      row.generation !== l.generation ||
      row.until <= Date.now()
    )
      throw new ApiError(503, "LEASE_LOST", "Session ownership unavailable.");
    return structuredClone(row);
  }
  private event(
    row: Row,
    type: StatusEvent["type"],
    revision: string,
    payload: Record<string, unknown>,
  ): void {
    this.sequence =
      (this.sequence > BigInt(Date.now()) * 1000n
        ? this.sequence
        : BigInt(Date.now()) * 1000n) + 1n;
    row.events.push({
      id: randomUUID(),
      sequence: String(this.sequence),
      application_id: row.app,
      user_id: row.user,
      type,
      revision,
      occurred_at: new Date().toISOString(),
      payload,
    });
  }
  private connection(
    row: Row,
    status: State,
    phone: string | null = null,
  ): void {
    row.status = status;
    row.phone = status === "connected" ? phone : null;
    row.revision = String(BigInt(row.revision) + 1n);
    this.event(row, "connection", row.revision, {
      status: row.status,
      phone: row.phone,
    });
  }
  private result(
    row: Row,
    key: string,
    state: Submission["state"],
    messageId: string | null = null,
  ): void {
    const submission = row.submissions[key];
    submission.state = state;
    submission.message_id = messageId;
    submission.revision = String(BigInt(submission.revision ?? "0") + 1n);
    this.event(row, "submission", submission.revision, {
      idempotency_key: key,
      state,
      message_id: messageId,
      ...(state === "submitted" && !messageId
        ? { confirmation: "client_completed" }
        : {}),
    });
  }
  async claim(
    app: string,
    user: string,
    owner: string,
    max: number,
  ): Promise<Lease | null> {
    return this.serial(async () => {
      const id = keyFor(app, user);
      const previous = this.rows.get(id);
      if (previous?.owner && previous.until > Date.now()) return null;
      if (
        [...this.rows.values()].filter(
          (row) => row.owner && row.until > Date.now(),
        ).length >= max
      )
        throw new ApiError(
          503,
          "CAPACITY_EXCEEDED",
          "Session capacity exceeded.",
          true,
          2,
        );
      const row: Row = previous
        ? structuredClone(previous)
        : {
            app,
            user,
            generation: 0,
            until: 0,
            enabled: true,
            status: "disconnected",
            phone: null,
            revision: "0",
            auth: {},
            submissions: {},
            events: [],
          };
      row.owner = owner;
      row.generation++;
      row.until = Date.now() + 30000;
      row.enabled = true;
      this.connection(row, "connecting");
      for (const [key, submission] of Object.entries(row.submissions))
        if (submission.state === "pending")
          this.result(row, key, submission.dispatched ? "unknown" : "failed");
      await this.save(id, row);
      return { id, owner, generation: row.generation };
    });
  }
  async renew(l: Lease): Promise<void> {
    await this.serial(async () => {
      const row = this.fence(l);
      row.until = Date.now() + 30000;
      await this.save(l.id, row);
    });
  }
  async release(l: Lease): Promise<void> {
    await this.serial(async () => {
      const row = this.fence(l);
      row.owner = undefined;
      row.until = 0;
      this.connection(row, row.enabled ? "connecting" : "disconnected");
      await this.save(l.id, row);
    });
  }
  async restore(): Promise<{ app: string; user: string }[]> {
    return this.serial(async () => {
      const apps = await this.credentials();
      return [...this.rows.values()]
        .filter((row) => row.enabled && Object.hasOwn(apps, row.app))
        .map((row) => ({ app: row.app, user: row.user }));
    });
  }
  async status(id: string) {
    return this.serial(async () => {
      let row = this.rows.get(id);
      if (
        row &&
        row.enabled &&
        (!row.owner || row.until <= Date.now()) &&
        row.status !== "connecting"
      ) {
        row = structuredClone(row);
        this.connection(row, "connecting");
        await this.save(id, row);
      }
      return {
        status: row?.status ?? "disconnected",
        phone: row?.status === "connected" ? row.phone : null,
        revision: row?.revision ?? "0",
      };
    });
  }
  async update(
    l: Lease,
    status: State,
    phone: string | null = null,
  ): Promise<void> {
    await this.serial(async () => {
      const row = this.fence(l);
      if (row.status === status && row.phone === phone) return;
      this.connection(row, status, phone);
      await this.save(l.id, row);
    });
  }
  async auth(
    l: Lease,
    type: string,
    ids: string[],
  ): Promise<Record<string, any>> {
    return this.serial(async () => {
      const row = this.fence(l);
      const result: Record<string, any> = {};
      for (const id of ids) {
        const context = JSON.stringify([l.id, type, id]);
        if (row.auth[context])
          result[id] = this.vault.open(row.auth[context], context);
      }
      return result;
    });
  }
  async writeAuth(
    l: Lease,
    entries: { type: string; id: string; value: unknown | null }[],
  ): Promise<void> {
    await this.serial(async () => {
      const row = this.fence(l);
      for (const e of entries) {
        const context = JSON.stringify([l.id, e.type, e.id]);
        if (e.value == null) delete row.auth[context];
        else row.auth[context] = this.vault.seal(e.value, context);
      }
      await this.save(l.id, row);
    });
  }
  async clear(l: Lease): Promise<void> {
    await this.serial(async () => {
      const row = this.fence(l);
      row.auth = {};
      row.enabled = false;
      this.connection(row, "disconnected");
      await this.save(l.id, row);
    });
  }
  async reserve(
    l: Lease,
    key: string,
    hash: string,
    kind: "text" | "media" = "text",
  ) {
    return this.serial(async () => {
      const row = this.fence(l);
      const existing = Object.hasOwn(row.submissions, key)
        ? row.submissions[key]
        : undefined;
      if (existing) {
        if (existing.hash !== hash)
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Key already used for another payload.",
          );
        return { fresh: false, submission: existing };
      }
      const active = [...this.rows.values()]
        .flatMap((r) => Object.values(r.submissions))
        .filter((s) => s.state === "pending" && Date.now() - s.created < 30000);
      if (
        Object.values(row.submissions).some(
          (s) => s.state === "pending" && Date.now() - s.created < 30000,
        )
      )
        throw new ApiError(
          409,
          "SEND_IN_PROGRESS",
          "Account has an active submission.",
          true,
          2,
        );
      if (
        active.length >= 10 ||
        (kind === "media" &&
          active.filter((s) => (s as any).kind === "media").length >=
            this.mediaLimit)
      )
        throw new ApiError(
          503,
          "CAPACITY_EXCEEDED",
          "Send capacity exceeded.",
          true,
          2,
        );
      const submission = {
        state: "pending" as const,
        message_id: null,
        hash,
        dispatched: true,
        revision: "1",
        created: Date.now(),
        generation: l.generation,
        kind,
      };
      Object.defineProperty(row.submissions, key, {
        value: submission,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.event(row, "submission", "1", {
        idempotency_key: key,
        state: "pending",
        message_id: null,
      });
      await this.save(l.id, row);
      return { fresh: true, submission };
    });
  }
  async lookup(id: string, key: string): Promise<Submission | null> {
    return this.serial(async () => {
      const original = this.rows.get(id);
      if (!original || !Object.hasOwn(original.submissions, key)) return null;
      const row = structuredClone(original);
      if (
        row.submissions[key].state === "pending" &&
        Date.now() - row.submissions[key].created >= 30000
      ) {
        this.result(row, key, "unknown");
        await this.save(id, row);
      }
      return row.submissions[key];
    });
  }
  async finish(
    l: Lease,
    key: string,
    state: Submission["state"],
    messageId: string | null = null,
  ): Promise<void> {
    await this.serial(async () => {
      const row = this.fence(l);
      if (
        row.submissions[key]?.state === "pending" &&
        row.submissions[key].generation === l.generation
      ) {
        this.result(row, key, state, messageId);
        await this.save(l.id, row);
      }
    });
  }
  async events(app: string, after: string, limit: number): Promise<EventPage> {
    return this.serial(async () => {
      const appRows = [...this.rows.values()].filter((r) => r.app === app);
      if (appRows.some((r) => BigInt(after) < BigInt(r.floor ?? "0")))
        throw new ApiError(
          410,
          "EVENT_CURSOR_EXPIRED",
          "Reconcile snapshots before resuming events.",
        );
      const events = appRows
        .flatMap((r) => r.events)
        .filter((e) => BigInt(e.sequence) > BigInt(after))
        .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1));
      const page = events.slice(0, limit);
      return {
        success: true,
        events: page,
        next_cursor: page.at(-1)?.sequence ?? after,
        has_more: events.length > limit,
      };
    });
  }
  async snapshots(
    app: string,
    after: string,
    limit: number,
    cursor?: string,
  ): Promise<SnapshotPage> {
    return this.serial(async () => {
      const rows = [...this.rows]
        .filter(([id, r]) => r.app === app && id > after)
        .sort(([a], [b]) => a.localeCompare(b));
      if (
        cursor !== undefined &&
        [...this.rows.values()].some(
          (r) => r.app === app && BigInt(cursor) < BigInt(r.floor ?? "0"),
        )
      )
        throw new ApiError(
          410,
          "EVENT_CURSOR_EXPIRED",
          "Restart snapshot reconciliation.",
        );
      const page = rows.slice(0, limit);
      return {
        success: true,
        sessions: page.map(([, r]) => ({
          user_id: r.user,
          status: r.status,
          phone: r.phone,
          revision: r.revision,
        })),
        cursor: cursor ?? String(this.sequence),
        next_after: rows.length > limit ? page.at(-1)![0] : null,
      };
    });
  }
  async cleanup(): Promise<void> {
    await this.serial(async () => {
      for (const [id, original] of this.rows) {
        const row = structuredClone(original);
        let dirty = false;
        for (const [key, s] of Object.entries(row.submissions)) {
          if (s.state === "pending" && Date.now() - s.created >= 30000) {
            this.result(row, key, "unknown");
            dirty = true;
          }
        }
        const expired = row.events.filter(
          (e) => Date.now() - Date.parse(e.occurred_at) >= 7 * 86400000,
        );
        if (expired.length) {
          row.floor = expired.at(-1)!.sequence;
          row.events = row.events.filter(
            (e) => Date.now() - Date.parse(e.occurred_at) < 7 * 86400000,
          );
          dirty = true;
        }
        for (const [key, s] of Object.entries(row.submissions))
          if (s.state !== "pending" && Date.now() - s.created >= 7 * 86400000) {
            delete row.submissions[key];
            dirty = true;
          }
        if (dirty) await this.save(id, row);
      }
    });
  }
  async metrics() {
    return { backend: "files", sessions: this.rows.size };
  }
}
