import type { Database } from "bun:sqlite";

export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;
export const MAX_LOCK_TTL_MS = 12 * 60 * 60 * 1000;

export interface Lock {
  readonly name: string;
  readonly sessionId: string;
  readonly holder: string;
  readonly note: string;
  readonly auto: boolean;
  readonly acquiredMs: number;
  readonly expiresMs: number;
}

export interface Waiter {
  readonly name: string;
  readonly sessionId: string;
  readonly sinceMs: number;
}

export type Acquire =
  | { readonly ok: true; readonly renewed: boolean }
  | { readonly ok: false; readonly held: Lock };

export function createLockTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locks (
      name        TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      holder      TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      auto        INTEGER NOT NULL DEFAULT 0,
      acquired_ms INTEGER NOT NULL,
      expires_ms  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lock_waits (
      name       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      since_ms   INTEGER NOT NULL,
      PRIMARY KEY (name, session_id)
    );
  `);
}

/** `5m`, `2h`, `90s`, `1d` → ms; null when unparseable. */
export function parseDuration(raw: string): number | null {
  const m = /^(\d+)\s*([smhd])?$/i.exec(raw.trim());
  if (!m) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const scale = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "s" | "m" | "h" | "d"];
  return Math.min(MAX_LOCK_TTL_MS, Number(m[1]) * scale);
}

function rowToLock(row: Record<string, string | number>): Lock {
  return {
    name: String(row["name"]),
    sessionId: String(row["session_id"]),
    holder: String(row["holder"] ?? ""),
    note: String(row["note"] ?? ""),
    auto: Number(row["auto"]) === 1,
    acquiredMs: Number(row["acquired_ms"]),
    expiresMs: Number(row["expires_ms"]),
  };
}

/**
 * Named, time-limited resource locks: a test suite, a dev-server port, a
 * database fixture. Advisory, like claims — the lock tells, it never blocks.
 */
export class LockStore {
  constructor(private readonly db: Database) {}

  acquire(input: {
    readonly name: string;
    readonly sessionId: string;
    readonly holder: string;
    readonly ttlMs: number;
    readonly note?: string;
    readonly auto?: boolean;
    readonly nowMs: number;
  }): Acquire {
    const run = this.db.transaction((): Acquire => {
      const current = this.get(input.name, input.nowMs);
      if (current && current.sessionId !== input.sessionId) return { ok: false, held: current };
      this.db.query(
        `INSERT INTO locks (name, session_id, holder, note, auto, acquired_ms, expires_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           session_id = excluded.session_id, holder = excluded.holder,
           note = excluded.note, auto = excluded.auto, expires_ms = excluded.expires_ms`,
      ).run(
        input.name, input.sessionId, input.holder, input.note ?? "",
        input.auto === true ? 1 : 0, input.nowMs, input.nowMs + input.ttlMs,
      );
      this.db.query(`DELETE FROM lock_waits WHERE name = ? AND session_id = ?`)
        .run(input.name, input.sessionId);
      return { ok: true, renewed: current !== null };
    });
    return run.immediate();
  }

  /** Releases one lock; returns who was waiting, or null when not held by this session. */
  release(name: string, sessionId: string): Waiter[] | null {
    const run = this.db.transaction((): Waiter[] | null => {
      const row = this.db.query(`SELECT session_id FROM locks WHERE name = ?`).get(name) as
        | { session_id: string }
        | null;
      if (!row || row.session_id !== sessionId) return null;
      this.db.query(`DELETE FROM locks WHERE name = ?`).run(name);
      return this.takeWaiters(name);
    });
    return run.immediate();
  }

  /** Drops this session's auto-acquired locks; returns waiters per lock. */
  releaseAuto(sessionId: string): Array<{ name: string; waiters: Waiter[] }> {
    const run = this.db.transaction(() => {
      const rows = this.db.query(`SELECT name FROM locks WHERE session_id = ? AND auto = 1`)
        .all(sessionId) as Array<{ name: string }>;
      return rows.map(({ name }) => {
        this.db.query(`DELETE FROM locks WHERE name = ?`).run(name);
        return { name, waiters: this.takeWaiters(name) };
      });
    });
    return run.immediate();
  }

  /** Drops expired locks; returns each with its waiters so the caller can tell them. */
  sweep(nowMs: number): Array<{ lock: Lock; waiters: Waiter[] }> {
    const run = this.db.transaction(() => {
      const rows = this.db.query(`SELECT * FROM locks WHERE expires_ms <= ?`).all(nowMs) as Array<
        Record<string, string | number>
      >;
      return rows.map((row) => {
        const lock = rowToLock(row);
        this.db.query(`DELETE FROM locks WHERE name = ?`).run(lock.name);
        return { lock, waiters: this.takeWaiters(lock.name) };
      });
    });
    return run.immediate();
  }

  wait(name: string, sessionId: string, nowMs: number): void {
    this.db.query(
      `INSERT INTO lock_waits (name, session_id, since_ms) VALUES (?, ?, ?)
       ON CONFLICT (name, session_id) DO NOTHING`,
    ).run(name, sessionId, nowMs);
  }

  get(name: string, nowMs: number): Lock | null {
    const row = this.db.query(`SELECT * FROM locks WHERE name = ? AND expires_ms > ?`)
      .get(name, nowMs) as Record<string, string | number> | null;
    return row ? rowToLock(row) : null;
  }

  all(nowMs: number): Lock[] {
    const rows = this.db.query(`SELECT * FROM locks WHERE expires_ms > ? ORDER BY name`)
      .all(nowMs) as Array<Record<string, string | number>>;
    return rows.map(rowToLock);
  }

  waitersOf(name: string): Waiter[] {
    const rows = this.db.query(`SELECT * FROM lock_waits WHERE name = ? ORDER BY since_ms`)
      .all(name) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      name: String(row["name"]), sessionId: String(row["session_id"]), sinceMs: Number(row["since_ms"]),
    }));
  }

  private takeWaiters(name: string): Waiter[] {
    const waiters = this.waitersOf(name);
    this.db.query(`DELETE FROM lock_waits WHERE name = ?`).run(name);
    return waiters;
  }
}

/** Which configured lock a shell command would need, if any. */
export function lockForCommand(
  command: string,
  patterns: Readonly<Record<string, string>>,
): string | null {
  for (const [name, pattern] of Object.entries(patterns)) {
    if (pattern === "") continue;
    try {
      if (new RegExp(pattern).test(command)) return name;
    } catch {
      /* a bad pattern locks nothing */
    }
  }
  return null;
}
