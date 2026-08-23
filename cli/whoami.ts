import { bold, dim, handleColour } from "../core/colour.ts";
import {
  CLAIM_TTL_MS,
  displayName,
  hasUnread,
  rosterName,
  withStore,
  type Claim,
  type Session,
  type Store,
} from "../core/store.ts";
import { agentKey, agentState, progress, type AgentState } from "../core/work.ts";
import { booleanFlag, parseArguments, stringFlag } from "./args.ts";
import { failCommand } from "./command.ts";
import type { CliContext, CommandMap } from "./types.ts";

export interface WhoamiWork {
  readonly subject: string;
  readonly stepsDone: number;
  readonly stepsTotal: number;
}

/** Everything a statusline or script can know about one session, in one read. */
export interface Whoami {
  readonly sessionId: string;
  readonly name: string;
  readonly label: string;
  readonly role: string;
  readonly handle: string;
  readonly lineageFrom: string;
  readonly state: AgentState;
  readonly blocked: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly behindBase: number;
  readonly doing: WhoamiWork | null;
  readonly editing: string;
  readonly files: readonly string[];
  readonly contested: readonly string[];
  readonly minions: number;
  readonly peers: number;
  readonly unread: boolean;
}

function contestedPaths(
  claims: readonly Claim[],
  self: Session,
  mine: readonly string[],
): string[] {
  const owned = new Set(mine);
  const others = claims.filter(
    (claim) => claim.sessionId !== self.sessionId && owned.has(claim.path),
  );
  return [...new Set(others.map((claim) => claim.path))];
}

export function collectWhoami(
  store: Store,
  self: Session,
  nowMs: number,
  dbPath: string,
): Whoami {
  const edits = store.editsBy(self.sessionId, nowMs - CLAIM_TTL_MS);
  const files = edits.map((edit) => edit.path);
  const open = store.work.openItems(agentKey(self.title, self.sessionId));
  const latest = open[0];
  const steps = latest ? progress(store.work.steps(latest.workId)) : null;
  return {
    sessionId: self.sessionId,
    name: displayName(self),
    label: rosterName(self),
    role: self.role,
    handle: self.handle,
    lineageFrom: self.lineageFrom,
    state: agentState(self, nowMs),
    blocked: self.blocked,
    worktree: self.worktree,
    branch: self.branch,
    baseBranch: self.baseBranch,
    behindBase: self.behindBase,
    doing:
      latest && steps
        ? { subject: latest.subject, stepsDone: steps.done, stepsTotal: steps.total }
        : null,
    editing: files[0] ?? "",
    files,
    contested: contestedPaths(store.allClaims(nowMs), self, files),
    minions: store.liveMinions(nowMs).get(self.sessionId)?.length ?? 0,
    peers: store.liveSessions(nowMs).filter((s) => s.sessionId !== self.sessionId).length,
    unread: hasUnread(dbPath, self.sessionId),
  };
}

export function createWhoamiCommands(context: CliContext): CommandMap {
  const whoami = (args: readonly string[]): void => {
    const parsed = parseArguments(args, {
      booleanFlags: ["--json"],
      valueFlags: ["--session"],
      maxPositionals: 0,
    });
    if (!parsed.ok) return failCommand(context, `whoami: ${parsed.error}`);
    const json = booleanFlag(parsed.value, "--json");
    const sessionId = stringFlag(parsed.value, "--session") ?? context.sessionId;
    if (sessionId === "") {
      context.error(dim("whoami: no session — set CLAUDE_CODE_SESSION_ID or pass --session <id>."));
      context.fail();
      return;
    }
    const now = context.now();
    const me = withStore(context.dbPath, (store) => {
      const self = store.findBySession(sessionId);
      return self ? collectWhoami(store, self, now, context.dbPath) : null;
    });
    if (!me) {
      context.error(dim(`whoami: session ${sessionId.slice(0, 8)} is not on the roster.`));
      context.fail();
      return;
    }
    if (json) {
      context.log(JSON.stringify(me));
      return;
    }
    context.log(bold(handleColour(me.name)(me.label)));
  };
  return { whoami };
}
