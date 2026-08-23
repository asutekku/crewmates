import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { sessionEnvelope } from "../core/sessionBlock.ts";

const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0))
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(p + suffix); } catch { /* gone */ }
    }
});

describe("handoffs", () => {
  test("a note left on a branch reaches the next session there, until taken", () => {
    const db = `${tmpdir()}/crew-handoffs-${process.pid}.db`;
    paths.push(db);
    withStore(db, (store) => {
      const now = Date.now();
      store.register("gone", "", "feature/x", now - 1000);
      store.register("next", "", "feature/x", now);
      const id = store.handoffs.leave({
        branch: "feature/x", sessionId: "gone", agent: "ada", text: "hub view half wired, tests red",
        files: ["src/hub.ts"], nowMs: now - 500,
      });
      expect(store.handoffs.forBranch("feature/x", "next", now).map((h) => h.id)).toEqual([id]);
      expect(store.handoffs.forBranch("feature/x", "gone", now)).toEqual([]);
      expect(store.handoffs.forBranch("main", "next", now)).toEqual([]);

      const envelope = sessionEnvelope(store, {
        me: "bo", projectName: "t", sessionId: "next", tree: "", now, staleness: [], lineageFrom: "", branch: "feature/x",
      });
      const block = envelope.candidates.find((c) => c.key === "handoffs");
      expect(block?.text).toContain("hub view half wired");
      expect(block?.text).toContain("src/hub.ts");

      expect(store.handoffs.take(id, "bo", now)).toBe(true);
      expect(store.handoffs.take(id, "bo", now)).toBe(false);
      expect(store.handoffs.forBranch("feature/x", "next", now)).toEqual([]);
    });
  });

  test("leaving twice replaces the open note", () => {
    const db = `${tmpdir()}/crew-handoffs2-${process.pid}.db`;
    paths.push(db);
    withStore(db, (store) => {
      const now = Date.now();
      store.handoffs.leave({ branch: "b", sessionId: "s", agent: "a", text: "one", files: [], nowMs: now });
      store.handoffs.leave({ branch: "b", sessionId: "s", agent: "a", text: "two", files: [], nowMs: now + 1 });
      expect(store.handoffs.forBranch("b", "", now + 2).map((h) => h.text)).toEqual(["two"]);
    });
  });
});
