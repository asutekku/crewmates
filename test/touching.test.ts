import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { createTouchingCommands } from "../cli/touching.ts";

const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0))
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(p + suffix); } catch { /* gone */ }
    }
});

describe("crew touching", () => {
  test("claims paths and tells the peer that already holds one", () => {
    const db = `${tmpdir()}/crew-touching-${process.pid}.db`;
    paths.push(db);
    const now = Date.now();
    withStore(db, (store) => {
      store.register("me", "", "main", now);
      store.register("peer", "", "main", now);
      store.claim("peer", "src/shared.ts", now, {});
    });
    const logs: string[] = [];
    const errors: string[] = [];
    const { touching } = createTouchingCommands({
      dbPath: db,
      projectName: "t",
      projectRoot: process.cwd(),
      projectKey: "t",
      isGit: true,
      cwd: process.cwd(),
      binRoot: process.cwd(),
      sessionId: "me",
      now: () => now + 1,
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
      fail: () => {},
    });
    touching!(["src/shared.ts", "src/mine.ts"]);
    withStore(db, (store) => {
      expect(store.claimsSince("me", 0).sort()).toEqual(["src/mine.ts", "src/shared.ts"]);
      const mail = store.drainDirected("peer");
      expect(mail.length).toBe(1);
      expect(mail[0]?.body).toContain("about to edit src/shared.ts");
    });
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("held by");
  });
});
