import { statSync } from "node:fs";
import { dirtyFiles } from "./dirty.ts";

/**
 * A command that only reads. Anything else is treated as a possible write;
 * a wrong guess here costs one `git status`, never a missed edit.
 */
const READ_ONLY_HEAD =
  /^\s*(?:cd\s+\S+\s*&&\s*)?(?:ls|cat|head|tail|less|grep|rg|ag|find|fd|wc|stat|file|tree|pwd|which|type|echo|printf|env|printenv|date|whoami|du|df|diff|bun\s+test|npm\s+test|npx\s+tsc|tsc|git\s+(?:status|log|diff|show|branch|blame|rev-parse|remote|tag|describe|ls-files|stash\s+list))\b/;

export function looksReadOnly(command: string): boolean {
  if (/[>]|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bmkdir\b|\btouch\b|\bgit\s+(?:add|commit|checkout|merge|rebase|pull|stash|reset|apply|cherry-pick)\b/.test(command)) {
    return false;
  }
  return READ_ONLY_HEAD.test(command);
}

/** Dirty paths in `tree` whose mtime is at or after `sinceMs`. */
export function changedSince(tree: string, sinceMs: number): string[] {
  if (sinceMs <= 0) return [];
  const dirty = dirtyFiles(tree);
  if (dirty === null) return [];
  const out: string[] = [];
  for (const path of dirty) {
    try {
      if (statSync(`${tree}/${path}`).mtimeMs >= sinceMs - 1000) out.push(path);
    } catch {
      /* deleted or unreadable */
    }
  }
  return out;
}
