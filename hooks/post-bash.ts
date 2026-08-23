/**
 * PostToolUse(Bash): claim the files a shell command changed.
 *
 * Edit/Write go through pre-edit; a heredoc, `sed -i` or a script does not,
 * and those edits were invisible to every peer. The files are read off
 * `git status`, filtered by mtime since pre-bash marked the command's start,
 * and kept only when the command names them — the tree is shared, and a
 * peer's edit landing mid-command must not be claimed as this session's.
 */

import { changedSince } from "../core/bashEdits.ts";
import { loadCrewFile, matchesAny } from "../core/crewfile.ts";
import { runHook } from "../core/hook.ts";
import { resolveProject, worktreeRoot } from "../core/repo.ts";
import { emit, readPayload } from "../core/shared.ts";
import { claimName, withStore } from "../core/store.ts";

const MAX_CLAIMS = 40;

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const project = resolveProject(cwd);
  const tree = worktreeRoot(cwd);
  const crew = loadCrewFile(project.root);

  const notice = withStore(project.dbPath, (store) => {
    const now = Date.now();
    for (const { name, waiters } of store.locks.releaseAuto(sessionId)) {
      store.notifyLockFree(name, waiters, "the command finished", now);
    }
    const since = store.bashStartedMs(sessionId);
    if (since === 0) return null;
    store.markBashStart(sessionId, 0);
    const changed = changedSince(tree, since, payload.tool_input?.command ?? "")
      .filter((path) => !matchesAny(crew.generated, path))
      .slice(0, MAX_CLAIMS);
    if (changed.length === 0) return null;

    const overlaps: string[] = [];
    for (const path of changed) {
      const others = store.conflictingClaims(sessionId, path, now);
      store.claim(sessionId, path, now, { tool: "Bash", worktree: tree });
      if (others.length > 0) {
        overlaps.push(`${path} (${others.map((o) => claimName(o)).join(", ")})`);
      }
    }
    if (overlaps.length === 0) return null;
    return [
      `That command changed files another session is also editing:`,
      ...overlaps.map((line) => `- ${line}`),
      `\`crew blame <path>\` shows who has been in each; \`crew msg <name> "<text>"\` reaches them.`,
    ].join("\n");
  }, project.root);

  if (notice) emit("PostToolUse", notice, "presence: shell edit overlaps another agent");
}

await runHook(import.meta.file, main);
