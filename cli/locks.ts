import { bold, dim, green, handleColour, red, yellow } from "../core/colour.ts";
import { DEFAULT_LOCK_TTL_MS, parseDuration, type Lock } from "../core/locks.ts";
import { agoText, displayName, withStore } from "../core/store.ts";
import { parseArguments, stringFlag } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { notAnAgent } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

const LOCK_NAME = /^[a-z][a-z0-9-]{0,39}$/;

function untilText(lock: Lock, nowMs: number): string {
  const left = Math.max(0, lock.expiresMs - nowMs);
  const minutes = Math.ceil(left / 60_000);
  return minutes >= 60 ? `${Math.round(minutes / 60)}h left` : `${minutes}m left`;
}

export function createLockCommands(context: CliContext): CommandMap {
  const lock = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { valueFlags: ["--for", "--note"], maxPositionals: 1 });
    if (!parsed.ok) return failCommand(context, `lock: ${parsed.error}`);
    const name = (parsed.value.positionals[0] ?? "").trim();
    if (name === "") return failUsage(context, "lock");
    if (!LOCK_NAME.test(name)) return failCommand(context, "lock: names are lowercase, digits and dashes");
    if (context.sessionId === "") return notAnAgent(context, "`lock`");
    const forRaw = stringFlag(parsed.value, "--for");
    const ttl = forRaw === undefined ? DEFAULT_LOCK_TTL_MS : parseDuration(forRaw);
    if (ttl === null) return failCommand(context, "lock: --for takes 90s, 5m, 2h or 1d");
    const note = stringFlag(parsed.value, "--note") ?? "";

    withStore(context.dbPath, (store) => {
      const now = context.now();
      store.sweepLocks(now);
      const self = store.findBySession(context.sessionId);
      if (!self) return notAnAgent(context, "`lock`");
      const me = displayName(self);
      const result = store.locks.acquire({ name, sessionId: self.sessionId, holder: me, ttlMs: ttl, note, nowMs: now });
      if (result.ok) {
        const verb = result.renewed ? "renewed" : "holds";
        context.log(`${green("✓")} ${bold(handleColour(me)(me))} ${verb} ${bold(name)} ${dim(`for ${Math.round(ttl / 60_000)}m`)}`);
        context.log(dim(`  \`crew unlock ${name}\` when done; it expires on its own otherwise.`));
        return;
      }
      const held = result.held;
      store.locks.wait(name, self.sessionId, now);
      context.error(`${red("✗")} ${bold(name)} is held by ${bold(handleColour(held.holder)(held.holder))} ${dim(`(${untilText(held, now)}${held.note !== "" ? `, "${held.note}"` : ""})`)}`);
      context.error(dim(`  You are in line: a message arrives when it frees or expires. \`crew msg ${held.holder} "…"\` to hurry it.`));
      context.fail();
    });
  };

  const unlock = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { maxPositionals: 1 });
    if (!parsed.ok) return failCommand(context, `unlock: ${parsed.error}`);
    const name = (parsed.value.positionals[0] ?? "").trim();
    if (name === "") return failUsage(context, "unlock");
    if (context.sessionId === "") return notAnAgent(context, "`unlock`");
    withStore(context.dbPath, (store) => {
      const now = context.now();
      const self = store.findBySession(context.sessionId);
      if (!self) return notAnAgent(context, "`unlock`");
      const waiters = store.locks.release(name, self.sessionId);
      if (waiters === null) {
        context.error(`${red("✗")} you do not hold ${bold(name)}`);
        context.fail();
        return;
      }
      store.notifyLockFree(name, waiters, `${displayName(self)} released it`, now);
      const told = waiters.length > 0 ? ` — ${waiters.length} waiting agent(s) told` : "";
      context.log(`${green("✓")} ${bold(name)} released${told}`);
    });
  };

  const locks = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { maxPositionals: 0 });
    if (!parsed.ok) return failCommand(context, `locks: ${parsed.error}`);
    withStore(context.dbPath, (store) => {
      const now = context.now();
      store.sweepLocks(now);
      const all = store.locks.all(now);
      if (all.length === 0) {
        context.log(dim("no locks held."));
        return;
      }
      for (const l of all) {
        const waiting = store.locks.waitersOf(l.name).length;
        const tail = [
          untilText(l, now),
          l.auto ? "auto" : "",
          l.note !== "" ? `"${l.note}"` : "",
          waiting > 0 ? yellow(`${waiting} waiting`) : "",
        ].filter((t) => t !== "").join(" · ");
        context.log(`  ${bold(l.name.padEnd(14))} ${handleColour(l.holder)(l.holder)} ${dim(`since ${agoText(l.acquiredMs, now)} · ${tail}`)}`);
      }
    });
  };

  return { lock, unlock, locks };
}
