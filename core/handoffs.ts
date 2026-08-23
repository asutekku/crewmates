import type { Database } from "bun:sqlite";

export const HANDOFF_KEEP_MS = 48 * 60 * 60 * 1000;

export interface Handoff {
  readonly id: number;
  readonly branch: string;
  readonly sessionId: string;
  readonly agent: string;
  readonly text: string;
  readonly files: readonly string[];
  readonly auto: boolean;
  readonly tsMs: number;
}

export function createHandoffTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      branch     TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent      TEXT NOT NULL DEFAULT '',
      text       TEXT NOT NULL,
      files      TEXT NOT NULL DEFAULT '',
      auto       INTEGER NOT NULL DEFAULT 0,
      ts_ms      INTEGER NOT NULL,
      taken_ms   INTEGER NOT NULL DEFAULT 0,
      taken_by   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS handoffs_branch ON handoffs (branch, taken_ms);
  `);
}

function rowToHandoff(row: Record<string, string | number>): Handoff {
  const files = String(row["files"] ?? "");
  return {
    id: Number(row["id"]),
    branch: String(row["branch"]),
    sessionId: String(row["session_id"]),
    agent: String(row["agent"] ?? ""),
    text: String(row["text"]),
    files: files === "" ? [] : files.split("\n"),
    auto: Number(row["auto"]) === 1,
    tsMs: Number(row["ts_ms"]),
  };
}

/**
 * What a session leaves for whoever works this branch next. Branch-scoped
 * because that is where half-done work lives; a folder note would not know
 * which checkout it was about.
 */
export class HandoffStore {
  constructor(private readonly db: Database) {}

  leave(input: {
    readonly branch: string;
    readonly sessionId: string;
    readonly agent: string;
    readonly text: string;
    readonly files: readonly string[];
    readonly auto?: boolean;
    readonly nowMs: number;
  }): number {
    const run = this.db.transaction((): number => {
      // One open note per session and branch: leaving twice replaces, never stacks.
      this.db.query(`DELETE FROM handoffs WHERE session_id = ? AND branch = ? AND taken_ms = 0`)
        .run(input.sessionId, input.branch);
      this.db.query(
        `INSERT INTO handoffs (branch, session_id, agent, text, files, auto, ts_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.branch, input.sessionId, input.agent, input.text,
        input.files.join("\n"), input.auto === true ? 1 : 0, input.nowMs,
      );
      return Number((this.db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    });
    return run.immediate();
  }

  /** Open notes for a branch that someone else left, newest first. */
  forBranch(branch: string, exceptSessionId: string, nowMs: number): Handoff[] {
    const rows = this.db.query(
      `SELECT * FROM handoffs WHERE branch = ? AND session_id != ? AND taken_ms = 0 AND ts_ms > ?
        ORDER BY ts_ms DESC`,
    ).all(branch, exceptSessionId, nowMs - HANDOFF_KEEP_MS) as Array<Record<string, string | number>>;
    return rows.map(rowToHandoff);
  }

  hasOpen(sessionId: string, branch: string): boolean {
    return this.db.query(
      `SELECT 1 FROM handoffs WHERE session_id = ? AND branch = ? AND taken_ms = 0 LIMIT 1`,
    ).get(sessionId, branch) !== null;
  }

  take(id: number, by: string, nowMs: number): boolean {
    const r = this.db.query(`UPDATE handoffs SET taken_ms = ?, taken_by = ? WHERE id = ? AND taken_ms = 0`)
      .run(nowMs, by, id);
    return r.changes > 0;
  }

  prune(nowMs: number): void {
    this.db.query(`DELETE FROM handoffs WHERE ts_ms <= ?`).run(nowMs - HANDOFF_KEEP_MS * 2);
  }
}
