/**
 * `crew subagent-statusline` — decorating Claude Code's agent panel rows.
 *
 * The contract under test: row context JSON in (tasks whose `id` is the
 * subagent's agent_id), `{id, content}` JSON lines out; a row matched to a
 * live minion is named for it, a blank minion `task` adopts the row's
 * description, and a row this project knows nothing about is left undecorated
 * rather than blanked. Everything fails open — malformed input renders as "no
 * decorations", never as an error the panel would show every 5 s tick.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import {
  formatElapsed,
  formatTokens,
  renderSubagentStatusline,
  shortModel,
} from "../cli/subagent-statusline.ts";

let n = 0;
const paths: string[] = [];

function freshPath(): string {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-sasl-${process.pid}-${n++}.db`;
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {
        /* already gone */
      }
    }
  }
});

const MAIN = "I:/Projects/Traffic";

function parsed(lines: string[]): Array<{ id: string; content: string }> {
  return lines.map((l) => JSON.parse(l) as { id: string; content: string });
}

describe("renderSubagentStatusline", () => {
  test("names a row after its live minion and appends the row's numbers", () => {
    const path = freshPath();
    const now = Date.now();
    withStore(path, (store) => {
      store.register("s1", MAIN, "master", now);
      store.setAlias("s1", "rin", now);
      store.startMinion("agent-a", "s1", now - 90_000, { agentType: "general-purpose" });
    });
    const lines = renderSubagentStatusline(
      path,
      {
        columns: 120,
        tasks: [
          {
            id: "agent-a",
            type: "local_agent",
            description: "Chase the flaky login test",
            startTime: new Date(now - 90_000).toISOString(),
            model: "claude-fable-5",
            contextWindowSize: 200_000,
            tokenCount: 12_345,
          },
        ],
      },
      now,
    );
    const [row] = parsed(lines);
    expect(row?.id).toBe("agent-a");
    expect(row?.content).toContain("Rin's Minion #1");
    expect(row?.content).toContain("12k tok");
    expect(row?.content).toContain("ctx 6%");
    expect(row?.content).toContain("1m");
    expect(row?.content).toContain("fable-5");
  });

  test("a blank minion task adopts the row's description, once", () => {
    const path = freshPath();
    const now = Date.now();
    withStore(path, (store) => {
      store.register("s1", MAIN, "master", now);
      store.startMinion("agent-a", "s1", now, {});
    });
    renderSubagentStatusline(
      path,
      { tasks: [{ id: "agent-a", tokenCount: 5, description: "First sighting" }] },
      now,
    );
    renderSubagentStatusline(
      path,
      { tasks: [{ id: "agent-a", tokenCount: 5, description: "Later, different text" }] },
      now,
    );
    withStore(path, (store) => {
      expect(store.liveMinions(now).get("s1")?.[0]?.task).toBe("First sighting");
    });
  });

  test("a row with no minion still gets its numbers; an unknown silent row gets nothing", () => {
    const path = freshPath();
    const now = Date.now();
    const lines = renderSubagentStatusline(
      path,
      {
        tasks: [
          { id: "stranger", tokenCount: 2000, contextWindowSize: 100_000 },
          { id: "mute" },
        ],
      },
      now,
    );
    const rows = parsed(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("stranger");
    expect(rows[0]?.content).toBe("2.0k tok · ctx 2%");
  });

  test("content is cut to the harness's column budget", () => {
    const path = freshPath();
    const now = Date.now();
    const lines = renderSubagentStatusline(
      path,
      { columns: 12, tasks: [{ id: "a", tokenCount: 123_456, contextWindowSize: 200_000 }] },
      now,
    );
    const [row] = parsed(lines);
    expect(row?.content.length).toBeLessThanOrEqual(12);
    expect(row?.content.endsWith("…")).toBe(true);
  });

  test("malformed input decorates nothing rather than throwing", () => {
    const path = freshPath();
    const now = Date.now();
    expect(renderSubagentStatusline(path, {}, now)).toEqual([]);
    expect(renderSubagentStatusline(path, { tasks: "nope" }, now)).toEqual([]);
    expect(renderSubagentStatusline(path, { tasks: [{ id: 7 }, null] }, now)).toEqual([]);
  });
});

describe("formatting helpers", () => {
  test("token counts read like a meter, not a ledger", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(56_789)).toBe("57k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });

  test("model ids drop the vendor prefix and snapshot date", () => {
    expect(shortModel("claude-fable-5")).toBe("fable-5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });

  test("elapsed times land in the unit a human would pick", () => {
    expect(formatElapsed(30_000)).toBe("30s");
    expect(formatElapsed(150_000)).toBe("2m");
    expect(formatElapsed(3_900_000)).toBe("1h05m");
  });
});
