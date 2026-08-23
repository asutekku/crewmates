import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";

import { changedSince, looksReadOnly } from "../core/bashEdits.ts";
import { clearDirtyCache } from "../core/dirty.ts";

describe("looksReadOnly", () => {
  test("plain reads are read-only", () => {
    for (const c of ["ls -la", "cat a.ts | head", "git status", "grep -rn foo src", "bun test test/x.test.ts"])
      expect(looksReadOnly(c), c).toBe(true);
  });
  test("writes are not", () => {
    for (const c of ["cat > a.ts <<'EOF'\nx\nEOF", "sed -i '' s/a/b/ a.ts", "python3 - <<'EOF'\nEOF", "git commit -m x", "ls > out.txt"])
      expect(looksReadOnly(c), c).toBe(false);
  });
});

describe("changedSince", () => {
  const dirs: string[] = [];
  afterEach(() => {
    clearDirtyCache();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("returns dirty files touched after the mark", () => {
    const tree = mkdtempSync(`${tmpdir()}/crew-bash-`);
    dirs.push(tree);
    spawnSync("git", ["init", "-q"], { cwd: tree });
    mkdirSync(`${tree}/src`);
    writeFileSync(`${tree}/src/old.ts`, "old");
    const before = Date.now() - 60_000;
    clearDirtyCache();
    expect(changedSince(tree, before)).toEqual(["src/old.ts"]);
    expect(changedSince(tree, Date.now() + 5_000)).toEqual([]);
    expect(changedSince(tree, 0)).toEqual([]);
  });
});
