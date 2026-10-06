import { createHash, randomUUID } from "node:crypto";
import { Histogram } from "./statistics.js";
import type { Connection } from "mysql2";
import mysql, {
  type Pool,
  type PoolConnection,
  type QueryResult,
  type RowDataPacket,
} from "mysql2/promise";
import { ApiError } from "./errors.js";
import { verifyMySQL } from "./schema.js";
import { Vault } from "./crypto.js";
import type { EventPage, SnapshotPage, StatusEvent } from "./events.js";
export type State = "disconnected" | "connecting" | "qr_required" | "connected";
export type Lease = { id: string; owner: string; generation: number };
export type Submission = {
  state: "pending" | "submitted" | "failed" | "unknown";
  message_id: string | null;
  hash: string;
  dispatched: boolean;
  revision?: string;
};
export const keyFor = (app: string, user: string) =>
  createHash("sha256")
    .update(JSON.stringify([app, user]))
    .digest("hex");
export interface Store {
  ready(): Promise<void>;
  close(): Promise<void>;
  credentials(): Promise<Record<string, string>>;
  claim(
    app: string,
    user: string,
    owner: string,
    max: number,
  ): Promise<Lease | null>;
  renew(lease: Lease): Promise<void>;
  release(lease: Lease): Promise<void>;
  restore(): Promise<{ app: string; user: string }[]>;
  status(
    id: string,
  ): Promise<{ status: State; phone: string | null; revision?: string }>;
  update(lease: Lease, status: State, phone?: string | null): Promise<void>;
  auth(lease: Lease, type: string, ids: string[]): Promise<Record<string, any>>;
  writeAuth(
    lease: Lease,
    entries: { type: string; id: string; value: unknown | null }[],
  ): Promise<void>;
  clear(lease: Lease): Promise<void>;
  reserve(
    lease: Lease,
    key: string,
    hash: string,
    kind?: "text" | "media",
  ): Promise<{ fresh: boolean; submission: Submission }>;
  lookup(id: string, key: string): Promise<Submission | null>;
  events(app: string, after: string, limit: number): Promise<EventPage>;
  snapshots(
    app: string,
    after: string,
    limit: number,
    cursor?: string,
  ): Promise<SnapshotPage>;
  finish(
    lease: Lease,
    key: string,
    state: Submission["state"],
    messageId?: string | null,
  ): Promise<void>;
  cleanup(): Promise<void>;
}
export function poolFromEnvironment(): Pool {
  const size = Number(process.env.DB_POOL_SIZE ?? 10);
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 50 ||
    !process.env.DB_HOST ||
    !process.env.DB_NAME ||
    !process.env.DB_USER ||
    !process.env.DB_PASSWORD
  )
    throw new Error("Database configuration required");
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: size,
    waitForConnections: true,
    queueLimit: 100,
    connectTimeout: 5000,
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...(process.env.DB_TLS === "true"
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  });
  pool.on("connection", (connection) => {
    (connection as unknown as Connection).query(
      "SET time_zone='+00:00'",
      (error) => {
        if (error) connection.destroy();
      },
    );
  });
  return pool;
}
const sqlLatency = new Histogram();
const poolLatency = new Histogram();
let sqlFailures = 0;
function query<T extends QueryResult = QueryResult>(
  c: Pool | PoolConnection,
  sql: string,
  values: unknown[] = [],
) {
  const started = performance.now();
  return c
    .query<T>({ sql, timeout: 5000 }, values)
    .catch((error) => {
      sqlFailures++;
      throw error;
    })
    .finally(() => sqlLatency.observe(performance.now() - started));
}
export class SqlStore implements Store {
  constructor(
    public pool: Pool,
    private vault: Vault,
  ) {}
  async ready() {
    await verifyMySQL(this.pool);
  }
  async close() {
    await this.pool.end();
  }
  async credentials() {
    const [rows] = await query<RowDataPacket[]>(
      this.pool,
      "SELECT app_id, token_hash FROM wa_applications",
    );
    return Object.fromEntries(rows.map((r) => [r.app_id, r.token_hash]));
  }
  private async tx<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    const acquired = performance.now();
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const pending = this.pool.getConnection().then((connection) => {
      if (expired) {
        connection.release();
        throw new Error("Pool acquisition timeout");
      }
      return connection;
    });
    const c = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("Pool acquisition timeout"));
        }, 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    poolLatency.observe(performance.now() - acquired);
    let destroyed = false;
    try {
      await query(c, "START TRANSACTION");
      const result = await fn(c);
      await query(c, "COMMIT");
      return result;
    } catch (e) {
      destroyed = true;
      c.destroy();
      throw e;
    } finally {
      if (!destroyed) c.release();
    }
  }
  private async fence(c: PoolConnection, l: Lease) {
    const [rows] = await query<RowDataPacket[]>(
      c,
      "SELECT *, lease_until > NOW(3) AS alive FROM wa_sessions WHERE id=? FOR UPDATE",
      [l.id],
    );
    if (
      !rows[0] ||
      rows[0].owner !== l.owner ||
      Number(rows[0].generation) !== l.generation ||
      Number(rows[0].alive) !== 1
    )
      throw new ApiError(503, "LEASE_LOST", "Session ownership unavailable.");
    return rows[0];
  }
  private user(row: RowDataPacket) {
    return Buffer.isBuffer(row.user_id) ? row.user_id.toString() : row.user_id;
  }
  private async event(
    c: PoolConnection,
    row: RowDataPacket,
    type: "connection" | "submission",
    revision: string,
    payload: Record<string, unknown>,
  ) {
    await query(
      c,
      "INSERT INTO wa_event_streams (app_id) VALUES (?) ON DUPLICATE KEY UPDATE app_id=VALUES(app_id)",
      [row.app_id],
    );
    const [streams] = await query<RowDataPacket[]>(
      c,
      "SELECT last_seq FROM wa_event_streams WHERE app_id=? FOR UPDATE",
      [row.app_id],
    );
    const sequence = (BigInt(streams[0].last_seq) + 1n).toString();
    await query(c, "UPDATE wa_event_streams SET last_seq=? WHERE app_id=?", [
      sequence,
      row.app_id,
    ]);
    await query(
      c,
      "INSERT INTO wa_events (app_id,sequence,event_id,user_id,event_type,revision,payload) VALUES (?,?,?,?,?,?,?)",
      [
        row.app_id,
        sequence,
        randomUUID(),
        row.user_id,
        type,
        revision,
        JSON.stringify(payload),
      ],
    );
  }
  private async connection(
    c: PoolConnection,
    row: RowDataPacket,
    status: State,
    phone: string | null = null,
    force = false,
  ) {
    phone = status === "connected" ? phone : null;
    if (!force && row.status === status && row.phone === phone) return;
    const revision = (BigInt(row.revision) + 1n).toString();
    await query(
      c,
      "UPDATE wa_sessions SET status=?,phone=?,revision=? WHERE id=?",
      [status, phone, revision, row.id],
    );
    await this.event(c, row, "connection", revision, { status, phone });
    row.status = status;
    row.phone = phone;
    row.revision = revision;
  }
  private async result(
    c: PoolConnection,
    session: RowDataPacket,
    row: RowDataPacket,
    state: Submission["state"],
    messageId: string | null = null,
  ) {
    if (row.state === state && row.message_id === messageId) return;
    const revision = (BigInt(row.revision) + 1n).toString();
    await query(
      c,
      "UPDATE wa_submissions SET state=?,message_id=?,revision=? WHERE session_id=? AND idempotency_key=?",
      [state, messageId, revision, row.session_id, row.idempotency_key],
    );
    await this.event(c, session, "submission", revision, {
      idempotency_key: row.idempotency_key,
      state,
      message_id: messageId,
      ...(state === "submitted" && !messageId
        ? { confirmation: "client_completed" }
        : {}),
    });
    row.state = state;
    row.message_id = messageId;
    row.revision = revision;
  }
  async claim(
    app: string,
    user: string,
    owner: string,
    max: number,
  ): Promise<Lease | null> {
    const id = keyFor(app, user);
    return this.tx(async (c) => {
      await query(c, "SELECT id FROM wa_control WHERE id=1 FOR UPDATE");
      await query(
        c,
        "INSERT IGNORE INTO wa_sessions (id,app_id,user_id) VALUES (?,?,?)",
        [id, app, user],
      );
      const [rows] = await query<RowDataPacket[]>(
        c,
        "SELECT *,lease_until>NOW(3) AS alive FROM wa_sessions WHERE id=? FOR UPDATE",
        [id],
      );
      const row = rows[0];
      if (Number(row.alive) === 1) return null;
      const [counts] = await query<RowDataPacket[]>(
        c,
        "SELECT COUNT(*) AS n FROM wa_sessions WHERE lease_until>NOW(3)",
      );
      if (Number(counts[0].n) >= max)
        throw new ApiError(
          503,
          "CAPACITY_EXCEEDED",
          "Session capacity exceeded.",
          true,
          2,
        );
      const generation = Number(row.generation) + 1;
      await query(
        c,
        "UPDATE wa_sessions SET owner=?,generation=?,lease_until=TIMESTAMPADD(SECOND,30,NOW(3)),enabled=1 WHERE id=?",
        [owner, generation, id],
      );
      await this.connection(c, row, "connecting", null, true);
      const [pending] = await query<RowDataPacket[]>(
        c,
        "SELECT * FROM wa_submissions WHERE session_id=? AND state='pending' FOR UPDATE",
        [id],
      );
      for (const submission of pending)
        await this.result(
          c,
          row,
          submission,
          submission.dispatched ? "unknown" : "failed",
        );
      return { id, owner, generation };
    });
  }
  async renew(l: Lease) {
    await this.tx(async (c) => {
      await this.fence(c, l);
      await query(
        c,
        "UPDATE wa_sessions SET lease_until=TIMESTAMPADD(SECOND,30,NOW(3)) WHERE id=?",
        [l.id],
      );
    });
  }
  async release(l: Lease) {
    await this.tx(async (c) => {
      const row = await this.fence(c, l);
      await query(
        c,
        "UPDATE wa_sessions SET owner=NULL,lease_until=NULL WHERE id=?",
        [l.id],
      );
      await this.connection(
        c,
        row,
        row.enabled ? "connecting" : "disconnected",
        null,
        true,
      );
    });
  }
  async restore() {
    const [rows] = await query<RowDataPacket[]>(
      this.pool,
      "SELECT s.app_id,s.user_id FROM wa_sessions s JOIN wa_applications a ON a.app_id=s.app_id WHERE s.enabled=1",
    );
    return rows.map((row) => ({ app: row.app_id, user: this.user(row) }));
  }
  private async expire(id: string) {
    return this.tx(async (c) => {
      const [rows] = await query<RowDataPacket[]>(
        c,
        "SELECT *,lease_until>NOW(3) AS alive FROM wa_sessions WHERE id=? FOR UPDATE",
        [id],
      );
      const row = rows[0];
      if (row && Number(row.alive) !== 1 && row.owner) {
        await query(
          c,
          "UPDATE wa_sessions SET owner=NULL,lease_until=NULL WHERE id=?",
          [id],
        );
        await this.connection(
          c,
          row,
          row.enabled ? "connecting" : "disconnected",
          null,
          true,
        );
      }
      return row;
    });
  }
  async status(id: string) {
    const row = await this.expire(id);
    return {
      status: (row?.status ?? "disconnected") as State,
      phone: row?.status === "connected" ? row.phone : null,
      revision: String(row?.revision ?? 0),
    };
  }
  async update(l: Lease, status: State, phone: string | null = null) {
    await this.tx(async (c) => {
      const row = await this.fence(c, l);
      await this.connection(c, row, status, phone);
    });
  }
  async auth(l: Lease, type: string, ids: string[]) {
    return this.tx(async (c) => {
      await this.fence(c, l);
      const result: Record<string, any> = {};
      for (const id of ids) {
        const [rows] = await query<RowDataPacket[]>(
          c,
          "SELECT payload FROM wa_auth WHERE session_id=? AND key_type=? AND key_id=?",
          [l.id, type, id],
        );
        if (rows[0])
          result[id] = this.vault.open(
            rows[0].payload,
            JSON.stringify([l.id, type, id]),
          );
      }
      return result;
    });
  }
  async writeAuth(
    l: Lease,
    entries: { type: string; id: string; value: unknown | null }[],
  ) {
    await this.tx(async (c) => {
      await this.fence(c, l);
      for (const e of entries) {
        if (e.value == null)
          await query(
            c,
            "DELETE FROM wa_auth WHERE session_id=? AND key_type=? AND key_id=?",
            [l.id, e.type, e.id],
          );
        else
          await query(
            c,
            "INSERT INTO wa_auth (session_id,key_type,key_id,payload) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)",
            [
              l.id,
              e.type,
              e.id,
              this.vault.seal(e.value, JSON.stringify([l.id, e.type, e.id])),
            ],
          );
      }
    });
  }
  async clear(l: Lease) {
    await this.tx(async (c) => {
      const row = await this.fence(c, l);
      await query(c, "DELETE FROM wa_auth WHERE session_id=?", [l.id]);
      await query(c, "UPDATE wa_sessions SET enabled=0 WHERE id=?", [l.id]);
      await this.connection(c, row, "disconnected", null, true);
    });
  }
  async reserve(
    l: Lease,
    key: string,
    hash: string,
    kind: "text" | "media" = "text",
  ) {
    return this.tx(async (c) => {
      const [control] = await query<RowDataPacket[]>(
        c,
        "SELECT media_send_limit FROM wa_control WHERE id=1 FOR UPDATE",
      );
      const session = await this.fence(c, l);
      const [existing] = await query<RowDataPacket[]>(
        c,
        "SELECT * FROM wa_submissions WHERE session_id=? AND idempotency_key=? FOR UPDATE",
        [l.id, key],
      );
      if (existing[0]) {
        if (existing[0].payload_hash !== hash)
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Key already used for another payload.",
          );
        return { fresh: false, submission: this.submission(existing[0]) };
      }
      const [counts] = await query<RowDataPacket[]>(
        c,
        "SELECT COUNT(*) AS n FROM wa_submissions WHERE state='pending' AND dispatched=1 AND dispatch_until>NOW(3)",
      );
      const [active] = await query<RowDataPacket[]>(
        c,
        "SELECT idempotency_key FROM wa_submissions WHERE session_id=? AND state='pending' AND dispatched=1 AND dispatch_until>NOW(3)",
        [l.id],
      );
      if (active.length)
        throw new ApiError(
          409,
          "SEND_IN_PROGRESS",
          "Account has an active submission.",
          true,
          2,
        );
      if (Number(counts[0].n) >= 10)
        throw new ApiError(
          503,
          "CAPACITY_EXCEEDED",
          "Send capacity exceeded.",
          true,
          2,
        );
      if (kind === "media") {
        const [media] = await query<RowDataPacket[]>(
          c,
          "SELECT COUNT(*) AS n FROM wa_submissions WHERE state='pending' AND dispatched=1 AND dispatch_until>NOW(3) AND kind='media'",
        );
        if (Number(media[0].n) >= Number(control[0].media_send_limit))
          throw new ApiError(
            503,
            "CAPACITY_EXCEEDED",
            "Media send capacity exceeded.",
            true,
            2,
          );
      }
      await query(
        c,
        "INSERT INTO wa_submissions (session_id,idempotency_key,payload_hash,generation,kind,dispatched,dispatch_until,revision) VALUES (?,?,?,?,?,1,TIMESTAMPADD(SECOND,30,NOW(3)),1)",
        [l.id, key, hash, l.generation, kind],
      );
      await this.event(c, session, "submission", "1", {
        idempotency_key: key,
        state: "pending",
        message_id: null,
      });
      return {
        fresh: true,
        submission: {
          state: "pending" as const,
          message_id: null,
          hash,
          dispatched: true,
          revision: "1",
        },
      };
    });
  }
  private submission(row: RowDataPacket): Submission {
    return {
      state: row.state,
      message_id: row.message_id,
      hash: row.payload_hash,
      dispatched: !!row.dispatched,
      revision: String(row.revision),
    };
  }
  async lookup(id: string, key: string) {
    return this.tx(async (c) => {
      const [sessions] = await query<RowDataPacket[]>(
        c,
        "SELECT * FROM wa_sessions WHERE id=? FOR UPDATE",
        [id],
      );
      if (!sessions[0]) return null;
      const [rows] = await query<RowDataPacket[]>(
        c,
        "SELECT *,state='pending' AND dispatched=1 AND dispatch_until<NOW(3) AS expired FROM wa_submissions WHERE session_id=? AND idempotency_key=? FOR UPDATE",
        [id, key],
      );
      if (!rows[0]) return null;
      if (Number(rows[0].expired) === 1)
        await this.result(c, sessions[0], rows[0], "unknown");
      return this.submission(rows[0]);
    });
  }
  async finish(
    l: Lease,
    key: string,
    state: Submission["state"],
    messageId: string | null = null,
  ) {
    await this.tx(async (c) => {
      const session = await this.fence(c, l);
      const [rows] = await query<RowDataPacket[]>(
        c,
        "SELECT * FROM wa_submissions WHERE session_id=? AND idempotency_key=? AND state='pending' AND generation=? FOR UPDATE",
        [l.id, key, l.generation],
      );
      if (rows[0]) await this.result(c, session, rows[0], state, messageId);
    });
  }
  async events(app: string, after: string, limit: number): Promise<EventPage> {
    return this.tx(async (c) => {
      await query(
        c,
        "INSERT INTO wa_event_streams (app_id) VALUES (?) ON DUPLICATE KEY UPDATE app_id=VALUES(app_id)",
        [app],
      );
      const [streams] = await query<RowDataPacket[]>(
        c,
        "SELECT * FROM wa_event_streams WHERE app_id=? FOR UPDATE",
        [app],
      );
      const stream = streams[0];
      if (BigInt(after) < BigInt(stream.floor_seq))
        throw new ApiError(
          410,
          "EVENT_CURSOR_EXPIRED",
          "Reconcile snapshots before resuming events.",
        );
      if (BigInt(after) > BigInt(stream.last_seq))
        throw new ApiError(
          422,
          "INVALID_INPUT",
          "Cursor exceeds application stream.",
        );
      const [rows] = await query<RowDataPacket[]>(
        c,
        "SELECT * FROM wa_events WHERE app_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        [app, after, limit + 1],
      );
      const events: StatusEvent[] = rows.slice(0, limit).map((row) => ({
        id: row.event_id,
        sequence: String(row.sequence),
        application_id: row.app_id,
        user_id: this.user(row),
        type: row.event_type,
        revision: String(row.revision),
        occurred_at: new Date(row.created_at).toISOString(),
        payload: JSON.parse(row.payload),
      }));
      return {
        success: true,
        events,
        next_cursor: events.at(-1)?.sequence ?? after,
        has_more: rows.length > limit,
      };
    });
  }
  async snapshots(
    app: string,
    after: string,
    limit: number,
    cursor?: string,
  ): Promise<SnapshotPage> {
    const [expired] = await query<RowDataPacket[]>(
      this.pool,
      "SELECT id FROM wa_sessions WHERE app_id=? AND owner IS NOT NULL AND (lease_until IS NULL OR lease_until<=NOW(3))",
      [app],
    );
    for (const row of expired) await this.expire(row.id);
    return this.tx(async (c) => {
      await query(
        c,
        "INSERT INTO wa_event_streams (app_id) VALUES (?) ON DUPLICATE KEY UPDATE app_id=VALUES(app_id)",
        [app],
      );
      const [streams] = await query<RowDataPacket[]>(
        c,
        "SELECT * FROM wa_event_streams WHERE app_id=? FOR UPDATE",
        [app],
      );
      const stream = streams[0];
      const start = cursor ?? String(stream.last_seq);
      if (BigInt(start) < BigInt(stream.floor_seq))
        throw new ApiError(
          410,
          "EVENT_CURSOR_EXPIRED",
          "Snapshot cursor expired. Restart reconciliation.",
        );
      if (BigInt(start) > BigInt(stream.last_seq))
        throw new ApiError(422, "INVALID_INPUT", "Invalid snapshot cursor.");
      const [rows] = await query<RowDataPacket[]>(
        c,
        "SELECT * FROM wa_sessions WHERE app_id=? AND id>? ORDER BY id LIMIT ?",
        [app, after, limit + 1],
      );
      const page = rows.slice(0, limit);
      return {
        success: true,
        sessions: page.map((row) => ({
          user_id: this.user(row),
          status: row.status,
          phone: row.status === "connected" ? row.phone : null,
          revision: String(row.revision),
        })),
        cursor: start,
        next_after: rows.length > limit ? page.at(-1)!.id : null,
      };
    });
  }
  async metrics() {
    const [rows] = await query<RowDataPacket[]>(
      this.pool,
      "SELECT (SELECT COUNT(*) FROM wa_sessions WHERE lease_until>NOW(3)) AS leased_sessions,(SELECT COUNT(*) FROM wa_submissions WHERE state='pending') AS pending_submissions,(SELECT COUNT(*) FROM wa_submissions WHERE state='pending' AND dispatched=1 AND dispatch_until>NOW(3)) AS active_dispatches",
    );
    const [tables] = await query<RowDataPacket[]>(
      this.pool,
      "SELECT SUM(data_length) AS data_bytes,SUM(index_length) AS index_bytes,SUM(table_rows) AS estimated_rows FROM information_schema.TABLES WHERE table_schema=DATABASE() AND table_name LIKE 'wa\_%'",
    );
    return {
      ...rows[0],
      storage: tables[0],
      sql_latency: sqlLatency.snapshot(),
      pool_wait: poolLatency.snapshot(),
      sql_failures: sqlFailures,
      pool_limit: Number(process.env.DB_POOL_SIZE ?? 10),
    };
  }
  async cleanup() {
    const [expired] = await query<RowDataPacket[]>(
      this.pool,
      "SELECT id FROM wa_sessions WHERE owner IS NOT NULL AND (lease_until IS NULL OR lease_until<=NOW(3))",
    );
    for (const row of expired) await this.expire(row.id);
    const [pending] = await query<RowDataPacket[]>(
      this.pool,
      "SELECT session_id,idempotency_key FROM wa_submissions WHERE state='pending' AND ((dispatched=1 AND dispatch_until<NOW(3)) OR (dispatched=0 AND created_at<TIMESTAMPADD(SECOND,-30,NOW(3))))",
    );
    for (const row of pending) {
      await this.tx(async (c) => {
        const [sessions] = await query<RowDataPacket[]>(
          c,
          "SELECT * FROM wa_sessions WHERE id=? FOR UPDATE",
          [row.session_id],
        );
        const [submissions] = await query<RowDataPacket[]>(
          c,
          "SELECT *,dispatched=1 AND dispatch_until<NOW(3) AS expired FROM wa_submissions WHERE session_id=? AND idempotency_key=? FOR UPDATE",
          [row.session_id, row.idempotency_key],
        );
        const submission = submissions[0];
        if (
          submission?.state === "pending" &&
          (Number(submission.expired) === 1 || !submission.dispatched)
        )
          await this.result(
            c,
            sessions[0],
            submission,
            submission.dispatched ? "unknown" : "failed",
          );
      });
    }
    await query(
      this.pool,
      "DELETE FROM wa_submissions WHERE created_at<TIMESTAMPADD(DAY,-7,NOW(3)) AND state<>'pending'",
    );
    const [apps] = await query<RowDataPacket[]>(
      this.pool,
      "SELECT app_id FROM wa_event_streams",
    );
    for (const row of apps)
      await this.tx(async (c) => {
        await query(
          c,
          "SELECT app_id FROM wa_event_streams WHERE app_id=? FOR UPDATE",
          [row.app_id],
        );
        // Delete a contiguous prefix only; clocks or restored timestamps cannot create cursor gaps.
        const [first] = await query<RowDataPacket[]>(
          c,
          "SELECT MIN(sequence) AS sequence FROM wa_events WHERE app_id=? AND created_at>=TIMESTAMPADD(DAY,-7,NOW(3))",
          [row.app_id],
        );
        const [last] = await query<RowDataPacket[]>(
          c,
          "SELECT MAX(sequence) AS sequence FROM wa_events WHERE app_id=?",
          [row.app_id],
        );
        const through =
          first[0].sequence !== null
            ? (BigInt(first[0].sequence) - 1n).toString()
            : last[0].sequence;
        if (through !== null) {
          await query(
            c,
            "DELETE FROM wa_events WHERE app_id=? AND sequence<=?",
            [row.app_id, through],
          );
          await query(
            c,
            "UPDATE wa_event_streams SET floor_seq=GREATEST(floor_seq,?) WHERE app_id=?",
            [through, row.app_id],
          );
        }
      });
  }
}
