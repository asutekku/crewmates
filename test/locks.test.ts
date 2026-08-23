import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { lockForCommand, parseDuration } from "../core/locks.ts";
import { parseCrewFile } from "../core/crewfile.ts";
import { withStore } from "../core/store.ts";

const paths: string[] = [];
let n = 0;
function fresh<T>(fn: Parameters<typeof withStore>[1] extends (s: infer S) => unknown ? (s: S) => T : never): T {
  const p = `${tmpdir()}/crew-locks-${process.pid}-${n++}.db`;
  paths.push(p);
  return withStore(p, fn as never) as T;
}
afterEach(() => {
  for (const p of paths.splice(0))
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(p + suffix); } catch { /* gone */ }
    }
});

describe("parseDuration", () => {
  test("units and a bare number in minutes", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("3")).toBe(180_000);
    expect(parseDuration("soon")).toBeNull();
  });
});

describe("lockForCommand", () => {
  test("tests lock derives from checks.test", () => {
    const crew = parseCrewFile({ checks: { test: "bun test" }, locks: { dev: "vite|next dev" } });
    expect(lockForCommand("bun test test/x.test.ts", crew.locks)).toBe("tests");
    expect(lockForCommand("bunx vite --port 3000", crew.locks)).toBe("dev");
    expect(lockForCommand("ls", crew.locks)).toBeNull();
  });
});

describe("LockStore", () => {
  test("second holder is refused, queued, and told on release", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("a", "", "main", now);
      store.register("b", "", "main", now);
      expect(store.locks.acquire({ name: "tests", sessionId: "a", holder: "ada", ttlMs: 60_000, nowMs: now }).ok).toBe(true);
      const second = store.locks.acquire({ name: "tests", sessionId: "b", holder: "bo", ttlMs: 60_000, nowMs: now });
      expect(second.ok).toBe(false);
      store.locks.wait("tests", "b", now);
      const waiters = store.locks.release("tests", "a");
      expect(waiters?.map((w) => w.sessionId)).toEqual(["b"]);
      store.notifyLockFree("tests", waiters ?? [], "ada released it", now);
      expect(store.drainDirected("b")[0]?.body).toContain("lock `tests` is free");
      expect(store.locks.release("tests", "a")).toBeNull();
    });
  });

  test("expiry sweeps and notifies", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("a", "", "main", now);
      store.register("b", "", "main", now);
      store.locks.acquire({ name: "port-3000", sessionId: "a", holder: "ada", ttlMs: 1_000, nowMs: now });
      store.locks.wait("port-3000", "b", now);
      store.sweepLocks(now + 500);
      expect(store.locks.get("port-3000", now + 500)).not.toBeNull();
      store.sweepLocks(now + 2_000);
      expect(store.locks.get("port-3000", now + 2_000)).toBeNull();
      expect(store.drainDirected("b")[0]?.body).toContain("expired");
    });
  });

  test("auto locks release together", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("a", "", "main", now);
      store.locks.acquire({ name: "tests", sessionId: "a", holder: "ada", ttlMs: 60_000, auto: true, nowMs: now });
      store.locks.acquire({ name: "held", sessionId: "a", holder: "ada", ttlMs: 60_000, nowMs: now });
      expect(store.locks.releaseAuto("a").map((r) => r.name)).toEqual(["tests"]);
      expect(store.locks.all(now).map((l) => l.name)).toEqual(["held"]);
    });
  });
});
