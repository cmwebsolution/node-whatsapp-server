import { createHash } from "node:crypto";
import type { EventPage, SnapshotPage } from "./events.js";
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
