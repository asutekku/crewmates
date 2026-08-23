# Statusline — your agent's name in the Claude Code status bar

[← README](../README.md)

Claude Code's statusline runs a command of your choosing on every redraw and pipes it a JSON object on stdin. That object carries `session_id`, which is the key crewmates keeps the roster under — so one call to `crew whoami` turns it into the agent's name.

```
Izumi  Rainfall ⎇ ui/primitives-repaint
```

With eight windows open, the statusline is the one place the name appears _in_ the window it belongs to. That makes `crew msg izumi "…"` typeable without first asking each window who it is.

## `crew whoami`

| Form | Prints |
|---|---|
| `crew whoami` | the roster spelling: `Izumi`, or `Vega, Tooling Master` with a role set |
| `crew whoami --json` | one object, every field below |
| `crew whoami --session <id>` | either form, for a session other than the caller's |

From a hook the session is known through `CLAUDE_CODE_SESSION_ID`. The statusline process does not get that variable, so it passes `--session` with the id from stdin. A session that is not on the roster exits `1` with nothing on stdout; a statusline that pipes through `cat` shows an empty segment rather than an error.

### The JSON object

| Field | Type | Meaning |
|---|---|---|
| `name` | string | what peers type at `msg` — lowercase, one token |
| `label` | string | the roster spelling: capitalised, with lineage and role |
| `role` | string | from `set-role`; `""` when unset |
| `handle` | string | the pool-issued name, under any alias |
| `lineageFrom` | string | agent whose knowledge was taken up with `inherit`; `""` otherwise |
| `state` | `busy` \| `idle` \| `waiting` \| `gone` | derived from heartbeat and turn end; `waiting` means a permission prompt is open |
| `blocked` | string | the prompt text while `waiting` |
| `worktree`, `branch` | string | where the session is |
| `baseBranch`, `behindBase` | string, number | drift from the base ref; `behindBase` is `-1` until sampled |
| `doing` | object \| null | the open work item: `subject`, `stepsDone`, `stepsTotal`, `auto` (true when guessed from the conversation title) |
| `editing` | string | the path most recently claimed by an edit, within the claim TTL |
| `files` | string[] | every path claimed within the TTL, newest first |
| `contested` | string[] | paths in `files` another live agent also holds |
| `minions` | number | live subagents |
| `peers` | number | other live agents in this project |
| `unread` | boolean | a message is waiting for this session |

`files` tracks edits made through Claude Code's tools; a `sed` from Bash is invisible to it. The TTL is `claimTtlMs` (two hours by default), the same window the roster uses.

## Wiring it up

`~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
}
```

The smallest script that works:

```sh
#!/bin/sh
input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id')
dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir')
name=$(cd "$dir" && crew whoami --session "$sid" 2>/dev/null)
printf '%s  %s' "$name" "$(basename "$dir")"
```

`cd "$dir"` matters: `crew` resolves the project from the working directory, and the statusline's own cwd is not the project's.

A richer one reads the JSON once and draws what changed:

```sh
#!/bin/sh
input=$(cat)
sid=$(printf '%s' "$input" | jq -r '.session_id')
dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir')
me=$(cd "$dir" && crew whoami --json --session "$sid" 2>/dev/null) || exit 0

printf '%s' "$me" | jq -r '
  [ .label,
    (if .state == "waiting" then "⏸" elif .state == "busy" then "●" else "○" end),
    (if .doing == null then empty elif .doing.stepsTotal == 0 then .doing.subject else "\(.doing.subject) \(.doing.stepsDone)/\(.doing.stepsTotal)" end),
    (if .editing != "" then "✎ \(.editing | split("/") | last)" else empty end),
    (if (.contested | length) > 0 then "⚠ \(.contested | length) shared" else empty end),
    (if .unread then "✉" else empty end),
    (if .peers > 0 then "+\(.peers)" else empty end)
  ] | join("  ")'
```

Which gives lines like:

```
Izumi  ●  Map: hover bloom 2/4  ✎ battlefield.ts  ⚠ 1 shared  ✉  +2
```

## Cost

The statusline redraws often, and each `crew` call is a `bun` start plus one SQLite read — around 40 ms on a warm cache. If that shows, cache by session id:

```sh
cache="$HOME/.claude/agent-presence/statusline-cache/$sid.json"
if [ -f "$cache" ] && [ $(( $(date +%s) - $(stat -f %m "$cache") )) -lt 10 ]; then
  me=$(cat "$cache")
else
  me=$(cd "$dir" && crew whoami --json --session "$sid" 2>/dev/null) && printf '%s' "$me" > "$cache"
fi
```

`stat -f %m` is macOS; Linux reads `stat -c %Y`.
