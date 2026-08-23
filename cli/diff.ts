import { bold, dim, handleColour } from "../core/colour.ts";
import { CLAIM_TTL_MS, displayName, withStore } from "../core/store.ts";
import { parseArguments, parseSafeInteger, stringFlag } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { resolveLiveName } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

const MAX_HOURS = 24 * 14;

export interface PeerDiff {
  readonly name: string;
  readonly worktree: string;
  readonly paths: readonly string[];
}

export function gitDiff(tree: string, paths: readonly string[], stat: boolean): string {
  if (paths.length === 0) return "";
  const args = ["diff", "HEAD", ...(stat ? ["--stat"] : []), "--", ...paths];
  const proc = Bun.spawnSync(["git", ...args], { cwd: tree, stdout: "pipe", stderr: "ignore" });
  return proc.exitCode === 0 ? proc.stdout.toString() : "";
}

/** Untracked files have no diff against HEAD; they are listed by name. */
function untracked(tree: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const proc = Bun.spawnSync(
    ["git", "ls-files", "--others", "--exclude-standard", "--", ...paths],
    { cwd: tree, stdout: "pipe", stderr: "ignore" },
  );
  if (proc.exitCode !== 0) return [];
  return proc.stdout.toString().split("\n").filter((line) => line !== "");
}

export function createDiffCommands(context: CliContext): CommandMap {
  const diff = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { booleanFlags: ["--stat"], valueFlags: ["--hours"] });
    if (!parsed.ok) return failCommand(context, `diff: ${parsed.error}`);
    const target = parsed.value.positionals.join(" ").trim();
    if (target === "") return failUsage(context, "diff");
    const hours = parseSafeInteger(stringFlag(parsed.value, "--hours"), "hours", { min: 1, max: MAX_HOURS });
    if (!hours.ok) return failCommand(context, `diff: ${hours.error}`);
    const stat = parsed.value.flags.has("--stat");

    const peer = withStore(context.dbPath, (store): PeerDiff | string => {
      const now = context.now();
      const live = resolveLiveName(store.liveSessions(now), target);
      if (!live.ok) {
        return live.kind === "ambiguous"
          ? `ambiguous agent ${target}: ${live.candidates.join(", ")}`
          : `no live agent named ${target} in ${context.projectName}`;
      }
      const since = now - (hours.value === undefined ? CLAIM_TTL_MS : hours.value * 3_600_000);
      return {
        name: displayName(live.value),
        worktree: live.value.worktree || context.projectRoot,
        paths: store.editsBy(live.value.sessionId, since).map((edit) => edit.path),
      };
    });
    if (typeof peer === "string") return failCommand(context, `diff: ${peer}`);

    const who = bold(handleColour(peer.name)(peer.name));
    if (peer.paths.length === 0) {
      context.log(`${who} ${dim("has touched nothing in the window. `--hours n` widens it.")}`);
      return;
    }
    const tree = peer.worktree.split("/").pop() ?? peer.worktree;
    context.log(`${who} ${dim(`— ${peer.paths.length} file(s) in ${tree}, uncommitted against HEAD`)}`);
    const body = gitDiff(peer.worktree, peer.paths, stat);
    const fresh = untracked(peer.worktree, peer.paths);
    if (body.trim() === "" && fresh.length === 0) {
      context.log(dim("  Nothing uncommitted: their edits are already in HEAD, or the files are clean."));
      return;
    }
    if (body.trim() !== "") context.log(body.trimEnd());
    for (const path of fresh) context.log(dim(`  new file: ${path} (untracked, no diff)`));
  };
  return { diff };
}
