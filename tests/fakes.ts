import type { EventPage, SnapshotPage, StatusEvent } from "../src/events.js";
import { randomUUID } from "node:crypto";
import { ApiError } from "../src/errors.js";
import {
  keyFor,
  type Store,
  type Lease,
  type State,
  type Submission,
} from "../src/store.js";
export class MemoryStore implements Store {
  rows = new Map<
    string,
    {
      app: string;
      user: string;
      owner: string | null;
      generation: number;
      enabled: boolean;
      status: State;
      phone: string | null;
      revision: string;
    }
  >();
  values = new Map<string, unknown>();
  submissions = new Map<string, Submission>();
  fail = false;
  slots = 0;
  journal: StatusEvent[] = [];
  emit(
    id: string,
    type: "connection" | "submission",
    revision: string,
    payload: Record<string, unknown>,
  ) {
    const row = this.rows.get(id)!;
    this.journal.push({
      id: randomUUID(),
      sequence: String(
        this.journal.filter((e) => e.application_id === row.app).length + 1,
      ),
      application_id: row.app,
      user_id: row.user,
      type,
      revision,
      occurred_at: new Date().toISOString(),
      payload,
    });
  }
  async events(app: string, after: string, limit: number): Promise<EventPage> {
    const list = this.journal.filter(
      (e) => e.application_id === app && BigInt(e.sequence) > BigInt(after),
    );
    const events = list.slice(0, limit);
    return {
      success: true,
      events,
      next_cursor: events.at(-1)?.sequence ?? after,
      has_more: list.length > limit,
    };
  }
  async snapshots(
    app: string,
    after: string,
    limit: number,
    cursor?: string,
  ): Promise<SnapshotPage> {
    const list = [...this.rows]
      .filter(([id, r]) => r.app === app && id > after)
      .sort(([a], [b]) => a.localeCompare(b));
    return {
      success: true,
      sessions: list.slice(0, limit).map(([, r]) => ({
        user_id: r.user,
        status: r.status,
        phone: r.phone,
        revision: r.revision,
      })),
      cursor:
        cursor ??
        String(this.journal.filter((e) => e.application_id === app).length),
      next_after: list.length > limit ? list[limit - 1][0] : null,
    };
  }
  async ready() {
    if (this.fail) throw new Error("DB unavailable");
  }
  async close() {}
  async credentials() {
    return {};
  }
  fence(l: Lease) {
    if (this.fail) throw new Error("DB unavailable");
    const r = this.rows.get(l.id);
    if (!r || r.owner !== l.owner || r.generation !== l.generation)
      throw new ApiError(503, "LEASE_LOST", "Lease lost");
    return r;
  }
  async claim(app: string, user: string, owner: string, max: number) {
    const id = keyFor(app, user),
      old = this.rows.get(id);
    if (old?.owner) return null;
    if ([...this.rows.values()].filter((r) => r.owner).length >= max)
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Capacity");
    const generation = (old?.generation ?? 0) + 1;
    this.rows.set(id, {
      app,
      user,
      owner,
      generation,
      enabled: true,
      status: "connecting",
      phone: null,
      revision: String(Number(old?.revision ?? 0) + 1),
    });
    this.emit(id, "connection", this.rows.get(id)!.revision, {
      status: "connecting",
      phone: null,
    });
    for (const [k, s] of this.submissions) {
      if (k.startsWith(id) && s.state === "pending") {
        if (s.dispatched) this.slots--;
        this.mediaSlots.delete(k);
        s.state = s.dispatched ? "unknown" : "failed";
        s.revision = String(Number(s.revision) + 1);
        this.emit(id, "submission", s.revision, {
          idempotency_key: k.slice(id.length),
          state: s.state,
          message_id: null,
        });
      }
    }
    return { id, owner, generation };
  }
  async renew(l: Lease) {
    this.fence(l);
  }
  async release(l: Lease) {
    const r = this.fence(l);
    await this.update(l, r.enabled ? "connecting" : "disconnected");
    r.owner = null;
  }
  async restore() {
    return [...this.rows.values()]
      .filter((r) => r.enabled)
      .map((r) => ({ app: r.app, user: r.user }));
  }
  async status(id: string) {
    await this.ready();
    const r = this.rows.get(id);
    return {
      status: r?.status ?? ("disconnected" as State),
      phone: r?.phone ?? null,
      revision: r?.revision ?? "0",
    };
  }
  async update(l: Lease, status: State, phone: string | null = null) {
    const row = this.fence(l);
    phone = status === "connected" ? phone : null;
    if (row.status === status && row.phone === phone) return;
    Object.assign(row, {
      status,
      phone,
      revision: String(Number(row.revision) + 1),
    });
    this.emit(l.id, "connection", row.revision, { status, phone });
  }
  async auth(l: Lease, type: string, ids: string[]) {
    this.fence(l);
    const result: Record<string, any> = {};
    for (const id of ids)
      if (this.values.has(`${l.id}:${type}:${id}`))
        result[id] = this.values.get(`${l.id}:${type}:${id}`);
    return result;
  }
  async writeAuth(
    l: Lease,
    entries: { type: string; id: string; value: unknown | null }[],
  ) {
    this.fence(l);
    for (const e of entries) {
      const k = `${l.id}:${e.type}:${e.id}`;
      if (e.value == null) this.values.delete(k);
      else this.values.set(k, e.value);
    }
  }
  async clear(l: Lease) {
    const r = this.fence(l);
    r.enabled = false;
    await this.update(l, "disconnected");
    for (const k of this.values.keys())
      if (k.startsWith(l.id)) this.values.delete(k);
  }
  mediaSlots = new Set<string>();
  async reserve(
    l: Lease,
    key: string,
    hash: string,
    kind: "text" | "media" = "text",
  ) {
    this.fence(l);
    const k = l.id + key,
      s = this.submissions.get(k);
    if (s) {
      if (s.hash !== hash)
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Conflict");
      return { fresh: false, submission: s };
    }
    if (
      [...this.submissions].some(
        ([k, s]) => k.startsWith(l.id) && s.state === "pending",
      )
    )
      throw new ApiError(409, "SEND_IN_PROGRESS", "Account busy", true, 2);
    if (this.slots >= 10)
      throw new ApiError(503, "CAPACITY_EXCEEDED", "Capacity", true, 2);
    if (kind === "media" && this.mediaSlots.size >= 2)
      throw new ApiError(503, "CAPACITY_EXCEEDED", "Media capacity", true, 2);
    if (kind === "media") this.mediaSlots.add(k);
    this.slots++;
    const submission: Submission = {
      state: "pending",
      message_id: null,
      hash,
      dispatched: true,
      revision: "1",
    };
    this.submissions.set(k, submission);
    this.emit(l.id, "submission", "1", {
      idempotency_key: key,
      state: "pending",
      message_id: null,
    });
    return { fresh: true, submission };
  }
  async lookup(id: string, key: string) {
    await this.ready();
    return this.submissions.get(id + key) ?? null;
  }
  async finish(
    l: Lease,
    key: string,
    state: Submission["state"],
    messageId: string | null = null,
  ) {
    this.fence(l);
    const s = this.submissions.get(l.id + key)!;
    if (s.state === "pending") {
      if (s.dispatched) this.slots--;
      this.mediaSlots.delete(l.id + key);
      s.state = state;
      s.message_id = messageId;
      s.revision = String(Number(s.revision) + 1);
      this.emit(l.id, "submission", s.revision, {
        idempotency_key: key,
        state,
        message_id: messageId,
        ...(state === "submitted" && !messageId
          ? { confirmation: "client_completed" }
          : {}),
      });
    }
  }
  async cleanup() {}
}
