import { bold, cyan, dim, green, handleColour, red } from "../core/colour.ts";
import { PERSONAS, personaById, randomPersona } from "../core/personas.ts";
import { displayName, withStore } from "../core/store.ts";
import { parseArguments, stringFlag } from "./args.ts";
import { failCommand } from "./command.ts";
import { resolveSelf } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

export function createPersonaCommands(context: CliContext): CommandMap {
  const persona = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { valueFlags: ["--agent"], maxPositionals: 1 });
    if (!parsed.ok) return failCommand(context, `persona: ${parsed.error}`);
    const target = stringFlag(parsed.value, "--agent") ?? "";
    const pick = (parsed.value.positionals[0] ?? "").trim().toLowerCase();

    if (pick === "" || pick === "list") {
      for (const p of PERSONAS) {
        context.log(`  ${bold(cyan(p.id.padEnd(12)))} ${p.label}`);
        context.log(dim(`               ${p.voice.split(". ")[0]}.`));
      }
      context.log("");
      context.log(dim("  `crew persona <id>` takes one, `crew persona random` rolls, `crew persona off` drops it."));
      context.log(dim('  Repo-wide: `"persona": "random"` in .claude/crew.json. Tone only — never changes the work.'));
      return;
    }

    withStore(context.dbPath, (store) => {
      const now = context.now();
      const self = resolveSelf(context, store, target, now, "`persona`");
      if (!self) return;
      const me = displayName(self);
      if (pick === "off" || pick === "none") {
        store.setPersona(self.sessionId, "");
        context.log(`${green("✓")} ${bold(handleColour(me)(me))} ${dim("speaks plainly again. Takes effect at the next session start.")}`);
        return;
      }
      const chosen = pick === "random" ? randomPersona(`${self.sessionId}:${now}`) : personaById(pick);
      if (!chosen) {
        context.error(`${red("✗")} no persona ${bold(pick)} — \`crew persona\` lists them`);
        context.fail();
        return;
      }
      store.setPersona(self.sessionId, chosen.id);
      context.log(`${green("✓")} ${bold(handleColour(me)(me))} ${dim("is now")} ${bold(chosen.label)}`);
      context.log(dim("  Injected at session start: restart, or /clear, to hear it."));
    });
  };
  return { persona };
}
