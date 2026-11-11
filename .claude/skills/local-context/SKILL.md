---
name: local-context
description: Manages task-local working memory using a context directory. Use this skill at the start of a session to load active task status, decisions, blockers, and next steps. Triggers on /local-context, task slug mentions, "switch to X", "new task X", "what's active?", or any time the user wants to track or resume work on a specific task.
---

# Local Context

Per-task working memory. Each task lives in `<base>/<slug>/` containing `status.md`, `ticket.md`, optional `snippets/`, and optional `README.md`. `<base>/active` names the current slug.

## Base Directory Resolution

Stop at first match:

1. `.claude/local-context-config` in repo root → parse JSON, read `.base`.
2. `~/.claude/local-context-config` → same.
3. `.claude/context/` exists in repo root → use as `<base>`; write config.
4. None → ask user: project (`.claude/context/`) or home (`~/.claude/context`). Write config.

**Legacy plain-text config**: treat first line as `base`, rewrite as JSON.

## Config File Format

- `base` (required): absolute path to context directory
- `statusline_declined` (optional, boolean): set to `true` if the user declined the Statusline Bootstrap offer — suppresses the re-offer.

```json
{ "base": "/path/to/context" }
```

## Permission Bootstrap

After resolving `base` (Round 1, step 1), check whether the context directory already has Read/Write/Bash coverage in the project's `.claude/settings.json` **before** issuing any further reads.

**Check:** scan `.claude/settings.json` for an allow rule whose path pattern covers `<base>/**` (e.g. `Read(<base>/*)`, `Read(<base>/**)`). A glob like `Read(.claude/context/**)` or an exact path prefix match qualifies.

**If not covered:** present the user with a single offer:

> Context directory `<base>` is not in the allowlist. Add read/write permissions now so future startups are prompt-free?
> - **Yes** — add allow rules to `.claude/settings.json`
> - **No** — continue without adding (permission prompts may appear)

If the user accepts: add the following allow rules to `.claude/settings.json` (create the file if absent, merge with existing rules):
- `Read(<base>/**)`
- `Write(<base>/**)`
- `Bash(ls <base>/**)`

Confirm with: `✅ Context directory added to allowlist.`

If the user declines: proceed without adding rules; note that permission prompts may appear.

**If already covered:** skip silently — do not offer or mention it.

## Statusline Bootstrap

After **Permission Bootstrap**, check whether the user's Claude Code statusline already surfaces the active task slug. If not, offer to install it. The statusline reads `<base>/active` (resolved via `local-context-config`) and prints the slug as part of the CLI's persistent status row, so the user can always see which task they're on without asking.

**Check:** consider it covered if any of these are true:
- `~/.claude/settings.json` (or the project's `.claude/settings.json`) sets a `statusLine.command` that references `local-context`, `LC_SLUG`, the path `~/.claude/statusline.sh`, or otherwise reads `<base>/active`.
- The active `local-context-config` has `"statusline_declined": true`.

**If not covered:** present a single offer:

> Show the active local-context task slug in your CLI statusline? Installs `~/.claude/statusline.sh` and adds a `statusLine` entry to `~/.claude/settings.json`.
> - **Yes** — install
> - **No** — skip (you can ask later)

If the user accepts:

1. **Write** `~/.claude/statusline.sh` with the content below.
2. **Make it executable** via `Bash(chmod +x ~/.claude/statusline.sh)`.
3. **Merge** the `statusLine` block below into `~/.claude/settings.json` (preserve existing keys; only add `statusLine`).
4. Confirm with: `✅ Statusline installed — restart Claude Code to see it.`

If the user declines: write `"statusline_declined": true` into the active `local-context-config` (preserve other keys) so the offer doesn't recur.

**Note for the agent:** Claude Code's auto-mode classifier treats writing the statusline script as agent self-modification and may prompt the user even after they accept the offer. If a Write is denied, ask the user to approve the single Write/Edit operation — the offer-acceptance is the authorization signal but the harness may still require explicit per-action consent.

### `~/.claude/statusline.sh` content

```bash
#!/bin/bash
# Resolve local-context base from project config, then home config.
config=""
input=$(cat)
cwd=$(printf '%s' "$input" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('workspace',{}).get('current_dir') or d.get('cwd') or '')" 2>/dev/null)
if [ -n "$cwd" ] && [ -f "$cwd/.claude/local-context-config" ]; then
  config="$cwd/.claude/local-context-config"
elif [ -f "$HOME/.claude/local-context-config" ]; then
  config="$HOME/.claude/local-context-config"
fi
base=""
if [ -n "$config" ]; then
  base=$(python3 -c "import json; print(json.load(open('$config')).get('base',''))" 2>/dev/null)
fi
slug=""
if [ -n "$base" ] && [ -f "$base/active" ]; then
  slug=$(tr -d '[:space:]\n' < "$base/active")
fi
export LC_SLUG="$slug"
export LC_INPUT="$input"
python3 - <<'PYEOF'
import json, os
data = json.loads(os.environ.get('LC_INPUT') or '{}')
model = data.get('model', {}).get('display_name', '')
cwd = data.get('workspace', {}).get('current_dir') or data.get('cwd') or ''
basename = os.path.basename(cwd) if cwd else ''
slug = os.environ.get('LC_SLUG', '')
parts = []
if slug:
    parts.append(f'\033[36m📍 {slug}\033[0m')
if basename:
    parts.append(f'\033[2m{basename}\033[0m')
if model:
    parts.append(f'\033[2m{model}\033[0m')
print(' · '.join(parts))
PYEOF
```

### `~/.claude/settings.json` addition

```json
{
  "statusLine": {
    "type": "command",
    "command": "$HOME/.claude/statusline.sh"
  }
}
```

**If already covered:** skip silently — do not offer or mention it.

## Active Task Resolution

Stop at first match:

1. User-named slug matches `<base>/<slug>/` → adopt; write to `<base>/active`.
2. `<base>/active` names an existing subdir → adopt.
3. Exactly one subdir → adopt; write to `<base>/active`.
4. No subdirs, `<base>/status.md` exists → legacy single-task mode; use `<base>`.
5. Multiple subdirs, no pointer, no named slug → ask user; write to `<base>/active`.
6. `<base>` empty → create `status.md` from `status-template.md`.

If named slug has no matching subdir, ask to create it. On confirm: `mkdir`, write `status.md` from template, update `<base>/active`, run **New Task Enrichment**.

## Switching Tasks

On slug mention, "switch to X", "back on X", "what's active?", or "which tasks are tracked?": update `<base>/active`, run Startup Protocol. Do not proactively update `status.md`.

## Tool preference

**Use Read/Write tools for all file I/O during startup.** Do not use Bash to read file content (`cat`, `head`, `tail`). Reserve Bash for operations that have no Read/Write equivalent (e.g. `ls`, `git` commands, `gh` CLI). This keeps startup prompt-free.

**Parallelise aggressively.** Every round trip costs latency. Combine independent reads into a single message with multiple tool calls.

## Startup Protocol

The protocol has two rounds. No writes occur during startup.

### Round 1 — Resolve config + slug (sequential, 4 steps)

1. Read `local-context-config` (repo or home) to get `base`.
2. **Permission Bootstrap** — run the check described above. If the user accepts, write `.claude/settings.json` before continuing.
3. **Statusline Bootstrap** — run the check described above. Offer once; if the user declines or it's already covered, move on. Do not re-offer on subsequent startups unless the user asks.
4. Read `<base>/active` (or resolve slug from user input) to get the active task slug.

### Round 2 — Parallel load (single message, all at once)

Once `<base>` and `<slug>` are known, issue **all** of the following in one message:

- **Read** `<slug>/status.md` — always needed.
- **Read** `<slug>/ticket.md` — always read; provides full task context.
- **Read** `<slug>/jira-cache.json` — display cached data if present; no fetch.
- **Read** `<slug>/github-cache.json` — display cached data if present; no fetch.

A file that doesn't exist is fine — treat as absent.

Snippets are **not** touched during startup — no `ls`, no reads. Content is loaded on demand when explicitly requested.

### Output

```
✅ Local Context Loaded
Active Task: [task]
Last updated: [date or "unknown"]
Scope: [scope or "not yet determined"]

Jira: KEY-123 — [summary] | [status] | [assignee]  (cached)
PR: owner/repo#123 — [title] | [state] | [assignee] | [reviewDecision]  (cached)
```

Omit Jira/GitHub lines entirely if no cache exists. Do not label them as stale or prompt to refresh — the user will ask when they want fresh data.

If `status.md` is missing, do not create it unless asked.

## New Task Enrichment

When a task directory is first created, automatically run Jira and GitHub enrichment and write the cache files. This is the only time enrichment runs without an explicit user request.

**Jira:** scan `ticket.md` for keys matching `(WAL|HELP|PHX|GULL|HB|ARC|FIN|DATA|DOPS|DEV|RF|SUP)-\d+`. Fetch `summary, status, assignee, updated` for each key (Jira MCP, cloudId `foreup.atlassian.net`). Write `<slug>/jira-cache.json`.

**GitHub:** scan `status.md` and `ticket.md` for GitHub refs (full URL, `owner/repo#number`, or bare `#number` resolved via `git remote get-url origin`). Fetch PR or issue fields via `gh` CLI. Write `<slug>/github-cache.json`.

MCP not connected or `gh` unavailable → skip silently.

## Manual Enrichment

When the user explicitly asks to refresh Jira or GitHub data (e.g. "refresh jira", "check ticket status", "update github"), run the relevant fetch and display the result. Do not write to any cache file.

**Jira fetch fields:** `summary`, `status`, `assignee`, `updated`.

**PR fields:** `title`, `state` (open/closed/merged), `assignee`, `reviewDecision` (approved/changes requested/review required), `isDraft`, `updatedAt`.
**Issue fields:** `title`, `state` (open/closed), `assignee`, `updatedAt`.

Cache format (GitHub only, written at new-task enrichment time):

`github-cache.json` — `{ "owner/repo#123": { "type", "title", "state", "assignee", "reviewDecision", "isDraft", "updatedAt", "fetchedAt" } }`

## Context Rules

- Task-scoped only. Flag stale or ambiguous context before using it.
- Summarize large files; don't dump them into chat.
- Prefer narrow scope (`packages/report-writer`) over broad (`entire repo`).

## What NOT to put in status.md

- Anything derivable from code or git history.
- PII, credentials, or anything sensitive.
- Anything already in `CLAUDE.md`.

## Snippets Directory

Save task docs to `<active>/snippets/`, one topic per file. Every snippet **must** open with:

```markdown
# Title
_Summary: one sentence describing what's in this file._
```

Full content is loaded on demand when explicitly requested. The summary line makes the snippet useful when you ask for it without reading the whole file first.

## status.md Maintenance

Update only on explicit request. Write replacement, confirm with `✅ status.md updated`. Template in `status-template.md`.

## Archiving Tasks

When done, delete `<base>/<slug>/` or rename to `<slug>-archived/` and remove from `<base>/active`.

## Style

Short and factual. No filler. Label uncertainty as a question or blocker.
