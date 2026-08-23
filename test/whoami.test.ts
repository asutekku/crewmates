import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { agentKey } from "../core/work.ts";
import { collectWhoami } from "../cli/whoami.ts";
import { runCli } from "../cli/main.ts";

let n = 0;
const paths: string[] = [];

function freshPath(): string {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-whoami-${process.pid}-${n++}.db`;
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

describe("collectWhoami", () => {
  test("reads name, work, files, contention and peers in one pass", () => {
    const path = freshPath();
    withStore(path, (store) => {
      const now = Date.now();
      store.register("s1", MAIN, "master", now);
      store.register("s2", MAIN, "master", now);
      store.setAlias("s1", "vega", now);
      store.setRole("s1", "Tooling Master");
      store.claim("s1", "src/a.ts", now - 1000, { worktree: MAIN });
      store.claim("s1", "src/b.ts", now, { worktree: MAIN });
      store.claim("s2", "src/b.ts", now, { worktree: MAIN });
      store.work.open(agentKey("", "s1"), "vega", "Fix the fade", ["a", "b", "c"], now, "");
      store.post("s2-handle", "say", "hello", now);

      const self = store.findBySession("s1")!;
      const me = collectWhoami(store, self, now, path);
      expect(me.name).toBe("vega");
      expect(me.label).toContain("Vega");
      expect(me.role).toBe("Tooling Master");
      expect(me.branch).toBe("master");
      expect(me.doing).toEqual({ subject: "Fix the fade", stepsDone: 0, stepsTotal: 3 });
      expect(me.editing).toBe("src/b.ts");
      expect(me.files).toEqual(["src/b.ts", "src/a.ts"]);
      expect(me.contested).toEqual(["src/b.ts"]);
      expect(me.peers).toBe(1);
      expect(me.minions).toBe(0);
      expect(me.unread).toBe(true);
    });
  });
});

describe("crew whoami", () => {
  const run = (argv: string[], sessionId = "") => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    runCli(argv, {
      cwd: process.cwd(),
      binRoot: new URL("..", import.meta.url).pathname,
      sessionId,
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
      setExitCode: (c) => exits.push(c),
    });
    return { logs, errors, exits };
  };

  test("fails quietly with no session", () => {
    const out = run(["whoami"]);
    expect(out.logs).toEqual([]);
    expect(out.exits).toEqual([1]);
  });

  test("fails when the session is not on the roster", () => {
    const out = run(["whoami", "--session", "not-a-session"]);
    expect(out.logs).toEqual([]);
    expect(out.errors.join("\n")).toContain("not on the roster");
    expect(out.exits).toEqual([1]);
  });
});
