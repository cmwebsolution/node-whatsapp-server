import { integer } from "./settings.js";
import type { Pool } from "mysql2/promise";
export const schema = [
  `CREATE TABLE IF NOT EXISTS wa_applications (app_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, token_hash CHAR(64) CHARACTER SET ascii UNIQUE NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wa_control (id INT PRIMARY KEY) ENGINE=InnoDB`,
  `INSERT IGNORE INTO wa_control (id) VALUES (1)`,
  `CREATE TABLE IF NOT EXISTS wa_sessions (id CHAR(64) CHARACTER SET ascii PRIMARY KEY, app_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, user_id VARBINARY(256) NOT NULL, owner CHAR(36) CHARACTER SET ascii NULL, generation BIGINT UNSIGNED NOT NULL DEFAULT 0, lease_until DATETIME(3) NULL, enabled BOOLEAN NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'disconnected', phone VARCHAR(15) NULL, INDEX(enabled), INDEX(lease_until)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wa_auth (session_id CHAR(64) CHARACTER SET ascii NOT NULL, key_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, key_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload LONGTEXT NOT NULL, PRIMARY KEY(session_id,key_type,key_id), FOREIGN KEY(session_id) REFERENCES wa_sessions(id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS wa_submissions (session_id CHAR(64) CHARACTER SET ascii NOT NULL, idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload_hash CHAR(64) CHARACTER SET ascii NOT NULL, generation BIGINT UNSIGNED NOT NULL, state VARCHAR(16) NOT NULL DEFAULT 'pending', dispatched BOOLEAN NOT NULL DEFAULT 0, dispatch_until DATETIME(3) NULL, message_id VARCHAR(255) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(session_id,idempotency_key), INDEX(state,dispatch_until), INDEX(created_at), FOREIGN KEY(session_id) REFERENCES wa_sessions(id)) ENGINE=InnoDB`,
];
export async function verifyMySQL(pool: Pool) {
  const [rows] = await pool.query<import("mysql2/promise").RowDataPacket[]>({
    sql: "SELECT VERSION() AS version",
    timeout: 5000,
  });
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+/.test(rows[0]?.version ?? "") ||
    /mariadb/i.test(rows[0]?.version ?? "")
  )
    throw new Error("MySQL database required");
}
export async function migrate(pool: Pool) {
  await verifyMySQL(pool);
  for (const sql of schema) await pool.query(sql);
  // Explicit checks migrate existing MySQL schemas.
  for (const table of ["wa_sessions", "wa_submissions"]) {
    const [rows] = await pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
      [table, "revision"],
    );
    if (!rows.length)
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN revision BIGINT UNSIGNED NOT NULL DEFAULT 0`,
      );
  }
  for (const [table, column, definition] of [
    ["wa_control", "media_send_limit", "INT UNSIGNED NOT NULL DEFAULT 2"],
    ["wa_submissions", "kind", "VARCHAR(5) NOT NULL DEFAULT 'text'"],
  ]) {
    const [rows] = await pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
      [table, column],
    );
    if (!rows.length)
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
      );
  }
  await pool.query("UPDATE wa_control SET media_send_limit=? WHERE id=1", [
    integer("MEDIA_SEND_CONCURRENCY", 2, 1, 10),
  ]);
  await pool.query(
    "UPDATE wa_sessions SET revision=1 WHERE revision=0 AND (enabled=1 OR status<>'disconnected')",
  );
  await pool.query("UPDATE wa_submissions SET revision=1 WHERE revision=0");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS wa_event_streams (app_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,last_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,floor_seq BIGINT UNSIGNED NOT NULL DEFAULT 0) ENGINE=InnoDB`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS wa_events (app_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,sequence BIGINT UNSIGNED NOT NULL,event_id CHAR(36) CHARACTER SET ascii NOT NULL UNIQUE,user_id VARBINARY(256) NOT NULL,event_type VARCHAR(16) NOT NULL,revision BIGINT UNSIGNED NOT NULL,payload TEXT NOT NULL,created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),PRIMARY KEY(app_id,sequence),INDEX(created_at)) ENGINE=InnoDB`,
  );
  await pool.query(
    "INSERT IGNORE INTO wa_event_streams (app_id) SELECT app_id FROM wa_applications",
  );
}
