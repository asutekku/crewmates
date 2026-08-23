import { bold, cyan, dim, green, handleColour, red } from "../core/colour.ts";
import { dirtyFiles } from "../core/dirty.ts";
import { currentBranch, worktreeRoot } from "../core/repo.ts";
import { agoText, CLAIM_TTL_MS, displayName, withStore, type Store } from "../core/store.ts";
import { parseArguments, requireSafeInteger, stringFlag } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { notAnAgent } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

/** This session's claimed paths that are still uncommitted in its tree. */
export function unfinishedFiles(store: Store, sessionId: string, tree: string, nowMs: number): string[] {
  const dirty = dirtyFiles(tree);
  const mine = store.editsBy(sessionId, nowMs - CLAIM_TTL_MS).map((e) => e.path);
  return dirty === null ? mine : mine.filter((p) => dirty.has(p));
}

export function createHandoffCommands(context: CliContext): CommandMap {
  const leaving = (args: readonly string[]): void => {
    const parsed = parseArguments(args, {});
    if (!parsed.ok) return failCommand(context, `leaving: ${parsed.error}`);
    const text = parsed.value.positionals.join(" ").trim();
    if (text === "") return failUsage(context, "leaving");
    if (context.sessionId === "") return notAnAgent(context, "`leaving`");
    const tree = worktreeRoot(context.cwd);
    const branch = currentBranch(context.cwd);
    withStore(context.dbPath, (store) => {
      const now = context.now();
      const self = store.findBySession(context.sessionId);
      if (!self) return notAnAgent(context, "`leaving`");
      const files = unfinishedFiles(store, self.sessionId, tree, now);
      store.handoffs.leave({ branch, sessionId: self.sessionId, agent: displayName(self), text, files, nowMs: now });
      const where = branch === "" ? "this directory" : bold(branch);
      context.log(`${green("✓")} left for the next agent on ${where}${files.length > 0 ? dim(` with ${files.length} uncommitted file(s)`) : ""}`);
      context.log(dim("  It shows at their session start until they run `crew handoffs --took <id>`."));
    });
  };

  const handoffs = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { valueFlags: ["--took"], maxPositionals: 0 });
    if (!parsed.ok) return failCommand(context, `handoffs: ${parsed.error}`);
    const took = stringFlag(parsed.value, "--took");
    const branch = currentBranch(context.cwd);
    withStore(context.dbPath, (store) => {
      const now = context.now();
      if (took !== undefined) {
        const id = requireSafeInteger(took, "id", { min: 1, max: Number.MAX_SAFE_INTEGER });
        if (!id.ok) return failCommand(context, `handoffs: ${id.error}`);
        const self = store.findBySession(context.sessionId);
        const by = self ? displayName(self) : "operator";
        if (!store.handoffs.take(id.value, by, now)) {
          context.error(`${red("✗")} no open handoff #${id.value}`);
          context.fail();
          return;
        }
        context.log(`${green("✓")} handoff #${id.value} taken up by ${bold(by)}`);
        return;
      }
      const open = store.handoffs.forBranch(branch, "", now);
      if (open.length === 0) {
        context.log(dim(`nothing left behind on ${branch || "this directory"}.`));
        return;
      }
      for (const h of open) {
        const who = handleColour(h.agent)(h.agent);
        context.log(`  ${cyan(`#${h.id}`)} ${bold(who)} ${dim(agoText(h.tsMs, now))}${h.auto ? dim(" · auto") : ""}`);
        context.log(`     ${h.text}`);
        if (h.files.length > 0) context.log(dim(`     uncommitted: ${h.files.slice(0, 6).join(", ")}${h.files.length > 6 ? ` +${h.files.length - 6}` : ""}`));
      }
    });
  };

  return { leaving, handoffs };
}
