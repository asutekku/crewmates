import { bold, dim, green, handleColour, yellow } from "../core/colour.ts";
import { worktreeRoot } from "../core/repo.ts";
import { agoText, claimName, displayName, withStore, type Claim } from "../core/store.ts";
import { parseArguments } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { notAnAgent } from "./identity.ts";
import { resolveTrustedPath } from "./paths.ts";
import type { CliContext, CommandMap } from "./types.ts";

const MAX_PATHS = 40;

function holdersLine(path: string, holders: readonly Claim[], nowMs: number): string {
  const who = holders
    .map((h) => `${claimName(h)} (${agoText(h.tsMs, nowMs)})`)
    .join(", ");
  return `  ${yellow("⚠")} ${bold(path)} ${dim("— held by")} ${who}`;
}

export function createTouchingCommands(context: CliContext): CommandMap {
  const touching = (args: readonly string[]): void => {
    const parsed = parseArguments(args, {});
    if (!parsed.ok) return failCommand(context, `touching: ${parsed.error}`);
    if (parsed.value.positionals.length === 0) return failUsage(context, "touching");
    if (context.sessionId === "") return notAnAgent(context, "`touching`");
    if (parsed.value.positionals.length > MAX_PATHS)
      return failCommand(context, `touching: at most ${MAX_PATHS} paths at once`);

    const tree = worktreeRoot(context.cwd);
    const paths: string[] = [];
    for (const raw of parsed.value.positionals) {
      const resolved = resolveTrustedPath(raw, tree);
      if (!resolved.ok) return failCommand(context, `touching: ${raw}: ${resolved.error}`);
      paths.push(resolved.value.relative);
    }

    withStore(context.dbPath, (store) => {
      const now = context.now();
      const self = store.findBySession(context.sessionId);
      if (!self) return notAnAgent(context, "`touching`");
      const me = displayName(self);
      const handle = self.handle;

      const warned = new Map<string, Claim>();
      const lines: string[] = [];
      for (const path of paths) {
        const holders = store.conflictingClaims(context.sessionId, path, now);
        store.claim(context.sessionId, path, now, { tool: "intent", worktree: tree });
        if (holders.length === 0) continue;
        lines.push(holdersLine(path, holders, now));
        for (const h of holders) if (!warned.has(h.sessionId)) warned.set(h.sessionId, h);
      }

      const list = paths.length > 3 ? `${paths.slice(0, 3).join(", ")} +${paths.length - 3}` : paths.join(", ");
      for (const holder of warned.values()) {
        const shared = paths.filter((p) =>
          store.conflictingClaims(context.sessionId, p, now).some((c) => c.sessionId === holder.sessionId),
        );
        store.post(handle, "claim", `about to edit ${shared.join(", ")} — you hold them too`, now, {
          sessionId: holder.sessionId,
          name: claimName(holder),
        });
      }

      context.log(`${green("✓")} ${bold(handleColour(me)(me))} ${dim("claims")} ${list}`);
      if (lines.length === 0) {
        context.log(dim("  Nobody else holds them. Peers editing these next will be warned."));
        return;
      }
      context.log("");
      for (const line of lines) context.log(line);
      const first = claimName([...warned.values()][0] as Claim);
      context.log(dim(`  They have been told. \`crew diff ${first}\` shows their changes; \`crew msg ${first} "…"\` reaches them.`));
    });
  };
  return { touching };
}
