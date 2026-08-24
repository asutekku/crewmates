/**
 * `crew subagent-statusline` — the command behind Claude Code's
 * `subagentStatusLine` setting, which pipes the agent panel's row context in as
 * JSON and renders whatever JSON lines (`{id, content}`) come back on each row.
 *
 * This is where a minion stops being "Task (general-purpose)" and becomes
 * "Rin's Minion #3 · 12.4k tok · ctx 6% · 3m": the harness supplies the
 * per-subagent numbers no hook ever sees (token count, context window, model),
 * and the minions table supplies the name.
 *
 * Row context, as of Claude Code 2.1.241 (read from the payload builder):
 *   { session_id, cwd, columns, tasks: [{ id, name, type, status, description,
 *     label, startTime, model, effort, contextWindowSize, tokenCount,
 *     tokenSamples, cwd }] }
 * `tasks[].id` IS the subagent's agent_id — the same value SubagentStart hands
 * `startMinion` — which is what lets a row be matched to its minion here.
 *
 * FAIL OPEN, ALWAYS: an exception or exit ≠ 0 would surface as an error line in
 * the operator's panel every 5 s tick. A row this command cannot decorate is
 * simply not emitted; Claude Code renders such rows exactly as before.
 */

import { readFileSync } from "node:fs";

import { displayName, withStore } from "../core/store.ts";
import { minionName } from "../core/names.ts";
import type { CliContext, CommandMap } from "./types.ts";

/** Same cap as subagent-stop's roster line: a label, not a paragraph. */
const MAX_TASK = 80;

/** One row of the agent panel, as Claude Code serialises it. */
export interface SubagentRow {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly description?: unknown;
  readonly startTime?: unknown;
  readonly model?: unknown;
  readonly contextWindowSize?: unknown;
  readonly tokenCount?: unknown;
}

export interface SubagentStatuslineInput {
  readonly columns?: unknown;
  readonly tasks?: unknown;
}

/** 12345 → "12.3k", 999 → "999", 2_400_000 → "2.4M". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

/** "claude-fable-5" → "fable-5"; a trailing -YYYYMMDD snapshot date is noise. */
export function shortModel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function formatElapsed(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
  if (mins >= 1) return `${mins}m`;
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/**
 * Decorations for the rows this project can say something about, as emittable
 * JSON lines. Rows without a decoration are omitted rather than blanked.
 *
 * Runs inside ONE store transaction scope because it both reads (live minions,
 * parent names) and writes: a live minion whose `task` is still blank adopts
 * the row's description — SubagentStart never carries one, so this feed is the
 * first time the store can learn what a minion was asked to do. That backfill
 * is what makes `whoami --json`'s `activeMinions[].task` and the `who` roster
 * name live minions instead of only finished ones.
 */
export function renderSubagentStatusline(
  dbPath: string,
  input: SubagentStatuslineInput,
  nowMs: number,
): string[] {
  const rows = Array.isArray(input.tasks) ? (input.tasks as SubagentRow[]) : [];
  if (rows.length === 0) return [];
  return withStore(dbPath, (store) => {
    const byAgent = new Map<string, { seq: number; task: string; sessionId: string }>();
    const parentNames = new Map<string, string>();
    for (const [sessionId, minions] of store.liveMinions(nowMs)) {
      const parent = store.findBySession(sessionId);
      parentNames.set(sessionId, parent ? displayName(parent) : "");
      for (const m of minions) byAgent.set(m.agentId, m);
    }

    const lines: string[] = [];
    for (const row of rows) {
      if (typeof row?.id !== "string" || row.id === "") continue;
      const parts: string[] = [];

      const minion = byAgent.get(row.id);
      if (minion) {
        const parent = parentNames.get(minion.sessionId) ?? "";
        if (parent !== "") parts.push(minionName(parent, minion.seq));
        const description = typeof row.description === "string" ? row.description.trim() : "";
        if (minion.task === "" && description !== "")
          store.describeMinion(row.id, description.slice(0, MAX_TASK));
      }

      const tokens = typeof row.tokenCount === "number" ? row.tokenCount : 0;
      if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
      const window = typeof row.contextWindowSize === "number" ? row.contextWindowSize : 0;
      if (tokens > 0 && window > 0)
        parts.push(`ctx ${Math.min(100, Math.round((tokens * 100) / window))}%`);

      // startTime's wire format is unpinned (ISO string today), so it goes
      // through Date rather than assuming either representation.
      const started =
        typeof row.startTime === "string" || typeof row.startTime === "number"
          ? new Date(row.startTime).getTime()
          : Number.NaN;
      if (Number.isFinite(started) && nowMs > started) parts.push(formatElapsed(nowMs - started));

      if (typeof row.model === "string" && row.model !== "") parts.push(shortModel(row.model));

      if (parts.length === 0) continue;
      let content = parts.join(" · ");
      // The row shares its width with Claude Code's own segments; `columns` is
      // the budget the harness computed for decorations.
      const columns = typeof input.columns === "number" ? input.columns : 0;
      if (columns > 8 && content.length > columns) content = `${content.slice(0, columns - 1)}…`;
      lines.push(JSON.stringify({ id: row.id, content }));
    }
    return lines;
  });
}

export function createSubagentStatuslineCommands(context: CliContext): CommandMap {
  const handler = (): void => {
    let raw = "";
    try {
      // Synchronous on purpose: command handlers return void, and the 5 s
      // harness timeout leaves no room for an event-loop handoff anyway.
      raw = readFileSync(0, "utf8");
    } catch {
      return;
    }
    let input: SubagentStatuslineInput;
    try {
      input = JSON.parse(raw) as SubagentStatuslineInput;
    } catch {
      return;
    }
    try {
      const now = context.now();
      for (const line of renderSubagentStatusline(context.dbPath, input, now))
        context.log(line);
    } catch {
      // Fail open: a decoration is a nicety, an error line every tick is not.
    }
  };
  return { "subagent-statusline": handler };
}
