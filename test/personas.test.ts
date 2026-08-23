import { describe, expect, test } from "bun:test";

import { PERSONAS, personaById, personaLines, randomPersona } from "../core/personas.ts";
import { parseCrewFile } from "../core/crewfile.ts";
import { identityLines, sessionEnvelope } from "../core/sessionBlock.ts";
import { withStore } from "../core/store.ts";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

describe("personas", () => {
  test("ids are unique, lowercase, and every voice says how not what", () => {
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length);
    for (const p of PERSONAS) expect(p.id).toMatch(/^[a-z]+$/);
    expect(personaLines(PERSONAS[0]!).join(" ")).toContain("never WHAT you do");
  });

  test("random is stable per seed", () => {
    expect(randomPersona("abc").id).toBe(randomPersona("abc").id);
    expect(personaById("nope")).toBeUndefined();
  });

  test("crew.json persona key is read, lowercased", () => {
    expect(parseCrewFile({ persona: "Random" }).persona).toBe("random");
    expect(parseCrewFile({}).persona).toBe("");
  });

  test("the session header carries the persona, after the identity", () => {
    const db = `${tmpdir()}/crew-persona-${process.pid}.db`;
    try {
      withStore(db, (store) => {
        const now = Date.now();
        store.register("s", "", "main", now);
        const env = sessionEnvelope(store, {
          me: "ada", projectName: "t", sessionId: "s", tree: "", now, staleness: [], lineageFrom: "", persona: "pirate",
        });
        const header = env.mandatoryHeader.join("\n");
        expect(header.indexOf(identityLines("ada", "t")[0]!)).toBe(0);
        expect(header).toContain("Pirate");
        expect(header).toContain("drop it");
      });
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) { try { unlinkSync(db + suffix); } catch { /* gone */ } }
    }
  });
});
