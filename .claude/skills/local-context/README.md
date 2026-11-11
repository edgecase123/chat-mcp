# Local Context Skill

## Features

- Per-task working memory directory alongside your code
- Multiple concurrent tasks, switch by name
- Tracks status, objectives, acceptance criteria, next steps, and blockers in `status.md`
- Jira and GitHub enrichment on new task creation; manual refresh on demand
- Task-scoped notes and reference docs in `snippets/` — summaries loaded at startup, full content on demand
- Project-local (`.claude/context/`) or home-directory (`~/.claude/context`) storage
- First-run prompt configures storage location — no manual setup

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | Skill instructions loaded by Claude |
| `status-template.md` | Template written when creating a new task |
| `README.md` | This file |

## vs. CLAUDE.local.md

| | `CLAUDE.local.md` | Local Context skill |
|---|---|---|
| Scope | Entire project | One task at a time |
| Loaded | Every session | Opt-in (`/local-context`) |
| Purpose | Personal overrides, local config | Current task status, decisions, blockers, next steps |

Use `CLAUDE.local.md` for preferences that apply across all your work. Use local context for what you're actively working on — so every new session picks up where the last one left off.

## Setup

1. Copy `SKILL.md`, `README.md`, and `status-template.md` into `.claude/skills/local-context/` in your project
2. Invoke with `/local-context` at the start of a session
3. On first use you'll be prompted for storage location (project vs. home)
4. Subsequent sessions load active task context with no writes and no network calls

## Startup Behaviour

Startup reads only — no writes, no network calls:

1. Read config → resolve base path
2. Read `active` → resolve task slug
3. In parallel: read `status.md`, `ticket.md`, `jira-cache.json`, `github-cache.json`
4. Display cached Jira/GitHub data if present; otherwise omit

This keeps startup prompt-free and instantaneous regardless of network availability.

## Jira & GitHub Enrichment

Enrichment runs automatically once — when a new task is first created. After that it is manual only.

**To refresh:** ask explicitly, e.g. "refresh jira", "check ticket status", "update github". The skill fetches live data and overwrites the cache file.

**Why manual after creation?**
Automatic TTL-based refresh required writing a `session-state.json` on every startup. That write was consistently triggering permission prompts despite correct allowlist rules — a Claude Code glob-matching bug. Making enrichment manual eliminates the write entirely, so startup has zero side effects and zero prompts.

## Jira Integration

Keys matching `(WAL|HELP|PHX|GULL|HB|ARC|FIN|DATA|DOPS|DEV|RF|SUP)-\d+` in `ticket.md` are resolved on new task creation and on explicit request. Fetches `summary`, `status`, `assignee`, and `updated`. Cache stored in `<task>/jira-cache.json`. Requires an Atlassian MCP to be connected — skips silently if unavailable.

## GitHub Integration

GitHub PR and issue references in `status.md` or `ticket.md` are resolved on new task creation and on explicit request. Recognised formats:

- Full URL: `https://github.com/owner/repo/pull/123` or `.../issues/123`
- Short form: `owner/repo#123`
- Bare ref: `#123` (resolved against the repo's default remote)

PRs display: title, state (open/closed/merged), assignee, and review decision. Issues display: title, state, assignee. Cache stored in `<task>/github-cache.json`. Requires `gh` CLI installed and authenticated — skips silently if unavailable.

## Snippets

Save task docs to `<active>/snippets/`, one topic per file. Every snippet must open with:

```markdown
# Title
_Summary: one sentence describing what's in this file._
```

At startup only the title and summary line are loaded — full content is fetched on demand when you ask about a topic. Without a summary line the snippet is opaque at startup and won't be useful until explicitly requested.
