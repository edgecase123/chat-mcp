---
title: Settings reference
updated: 2026-11-15
covers:
  - src/index.ts
  - src/util/paths.ts
  - src/cli/web/server.ts
  - src/cli/color.ts
  - src/storage/db.ts
  - src/notify/transport.ts
  - src/supervise/broker.ts
  - src/supervise/mcp-listener.ts
  - src/supervise/mcp-http.ts
  - src/supervise/run-command-service.ts
---

# chat-mcp settings reference

Every configurable setting, and whether it can be surfaced in a UI config page.

| Mark | Meaning |
|---|---|
| ✅ **SURFACEABLE** | Persistent, safe to read and edit from a UI page (with the guardrails noted). |
| 🟡 **STATUS ONLY** | Show state (set/unset, list). Do not show values, or edits need a human-run command. |
| ⛔ **NOT SURFACEABLE** | Process-launch, per-invocation, test-only, or detected. Document only. |
| 🔧 **PROMOTE FIRST** | Hardcoded constant today. Surfaceable only after it becomes real config. |

Source: scan of `src/index.ts`, `src/util/paths.ts`, `src/supervise/*`, `src/storage/db.ts`,
`src/notify/transport.ts`, `src/cli/color.ts`. Built by grepping flags, env vars and constants,
not by reading every module. Verify before treating it as exhaustive.

---

## 1. Environment variables

| Variable | Purpose | Mark | Why |
|---|---|---|---|
| `CHAT_MCP_HOME` | State root: `chat.db`, `notify/`, `sock/`, `mcp/`, `adapters/`. Default `~/.chat-mcp`. | ⛔ | Read at process start and locates the DB the UI itself reads. Cannot change live. |
| `CHAT_MCP_HANDLE` | Default sender/recipient for `send`, `inbox`, `delete-room`, `boot`. | ⛔ | Per-process identity. |
| `CHAT_MCP_WAKE_TRANSPORT` | Selects the wake transport. Only `file-watch` exists; unknown names fall back to it. | ⛔ | Launch-time. Nothing to choose today. |
| `CHAT_MCP_DEBUG_KEYS` | Path for the Ink UI's keypress debug log. | ⛔ | Developer diagnostic. |
| `NO_COLOR` / `FORCE_COLOR` | CLI color. Precedence: `NO_COLOR` off, `FORCE_COLOR` on, else TTY autodetect. | ⛔ | Read once at import. Terminal only. |
| `NODE_TEST_CONTEXT` | Set by the node test runner. Makes `stateDir()` refuse an unset `CHAT_MCP_HOME`. | ⛔ | Test-only. |
| `CLAUDECODE` | Detected, not set by users. | ⛔ | Detected. |

## 2. CLI flags

### Persistent-intent flags (their value could live in config)

| Command | Flag | Default | Mark |
|---|---|---|---|
| `cli` | `--handle` | `user` | ✅ web/CLI default identity |
| `cli` | `--experimental` | off | ✅ UI preference (Ink vs REPL) |
| `web` | `--handle` | `user` | ✅ |
| `web` | `--port` **unset** | `127.0.0.1:3737`, falling back to an OS-assigned free port if 3737 is taken | ✅ applies on next launch |
| `web` | `--port <n>` **set** | honoured verbatim. 🛑 **No fallback — the server fails on `EADDRINUSE`.** | ✅ applies on next launch; a UI writing this must surface the failure |
| `web` | `--no-open` | open browser | ✅ applies on next launch |
| `install` / `uninstall` | `--handle`, `--scope`, `--cwd`, `--force`, `--context-total` | per adapter | 🟡 list installed adapters; install is a human-run command (a Claude Code `[Self-Modification]` classifier blocks agents writing the hook file) |

### Supervisor: `chat-mcp supervise <handle>`

| Flag | Default | Mark | Note |
|---|---|---|---|
| `--model` | CLI default | ✅ | applies on restart |
| `--binary` | `claude` | ✅ | applies on restart; validate path |
| `--driver` | `docker-claude` with `--container`, else `claude` | ✅ | applies on restart. No static default on purpose. |
| `--cwd` | none | ✅ | validate via `supervise/containment.ts` |
| `--resume <sessionId>` | none | ⛔ | per-launch |
| `--permission-mode` | `manual` (enforces allowlist) | ✅ | applies on restart; confirm before loosening |
| `--auto` | off | ✅ | confirm: replaces the written allowlist with the CLI's classifier |
| `--permission-prompts host\|none` | `none` | ✅ | applies on restart |
| `--no-reply` | off | ✅ | doorbell mode; applies on restart |
| `--allowed-tools` | narrow default list | ✅ | applies on restart; confirm widening. Allowlist deliberately excludes Bash. |
| `--container` | off | ✅ | applies on restart; first use needs the plan confirmation (see `container.json`) |

### Per-invocation flags (never persistent config)

| Command | Flags | Mark |
|---|---|---|
| `send` | `--from`, `--stdin`, `--json` | ⛔ |
| `inbox` | `--handle`, `--peek`, `--json` | ⛔ |
| `list` | `--all`, `--json` | ⛔ |
| `members`, `delete-room`, `boot` | `--from`, `--json` | ⛔ |
| `agents restart\|stop` | `--now` | ⛔ (the action itself is a UI button, not a setting) |
| `report-context` | `--handle`, `--used`, `--from-transcript`, `--total`, `--json` | ⛔ (runtime data, see section 4) |
| MCP shim | `--handle`, `--force-handle` | ⛔ per-session identity |

## 3. Persisted state files (under `stateDir()`)

| File | Contents | Written by | Mark | Guardrails |
|---|---|---|---|---|
| `projects.json` | per-handle project dirs | `project set\|list\|forget` | ✅ | Validate through containment checks. |
| `mounts.json` | per-handle extra container mounts, exposed at `/mnt/<key>` | `mount add\|list` | ✅ | Confirmation required. **Never allow mounting `stateDir()` into a container** (AGENTS.md ruling). |
| `limits.json` | the three limits on a project command: `maxConcurrent`, `timeoutMinutes`, `maxBufferMb` | an operator, by hand | ✅ | `maxConcurrent` is a security limit on host-process spawn. An unreadable file REFUSES commands rather than falling back. |
| `secrets.env` | shared Claude OAuth token, `0600` | `auth set-token` | 🟡 | Show set/unset only. Never return the value. |
| `tokens/<handle>` | per-handle bearer token digests for the HTTP MCP listener | supervisor | 🟡 | Show status. Rotate/clear OK. Never display. |
| `container.json` | per-handle plan confirmation, image build hash | supervisor | 🟡 | Show state. Confirmation must be a deliberate human action. |
| `adapters/` | installed per-handle wake scripts | `install` | 🟡 | List only. |
| `notify/`, `sock/`, `mcp/` | wake files, sockets, MCP manifests | runtime | ⛔ | Runtime plumbing, not settings. |
| `chat.db` | the database | runtime | ⛔ | See section 4 for the settings stored inside it. |

## 4. Settings and state stored in `chat.db`

| Item | Set via | Mark | Note |
|---|---|---|---|
| Room style: `succinct` or `custom` markdown (64 KB cap), or none | `set_style` tool | ✅ | Rooms only; a peer target is refused. |
| Agent status + focus (focus up to 80 chars) | `set_status` tool | ✅ | Runtime, but editable and useful in UI. |
| Context gauge (used/total) | `report_context` tool / CLI | 🟡 | Runtime measurement; display only. |
| Claims | `claim` / `release` tools | 🟡 | Runtime coordination state. |
| Approvals and grants (allowlist additions) | supervisor prompts | 🟡 | Show history. Approving is a deliberate human action. |
| Room membership, reads | `room_join` etc. | ⛔ | Messaging state. |

## 5. Hardcoded tunables (🔧 PROMOTE FIRST)

| Area | Constant | Value | Location |
|---|---|---|---|
| Broker | max in-flight | 4 | `supervise/broker.ts` |
| Broker | max connections | 8 | `supervise/broker.ts` |
| Broker | idle timeout | 60 s | `supervise/broker.ts` |
| Broker | max line | 64 KB | `supervise/broker.ts` |
| MCP listener | max connections | 8 | `supervise/mcp-listener.ts` |
| MCP listener | receive timeout | 10 s | `supervise/mcp-listener.ts` |
| MCP listener | max unauthenticated refusals | 3 | `supervise/mcp-listener.ts` |
| MCP HTTP | max body | 4 MB | `supervise/mcp-http.ts` |
| Shim | broker deadline | 16 min | `shim/broker-client.ts` |
| Shim | gauge stale-after | 15 min | `shim/gauge-freshness.ts` |
| Shim | planning band | 50 | `shim/gauge.ts` |
| Supervisor | graceful restart timeout | 30 s | `supervise/index.ts` |
| Socket | ack timeout | 2 s | `supervise/socket.ts` |
| Messages | body cap | 64 KB | `oneshot/send.ts`, `shim/tools/send.ts`, `messaging/room-send.ts` — three copies |

⚠️ **Every ROW ABOVE was re-checked against source on 2026-11-15, 14 of 14 — but 14 is a count
of rows verified, not an inventory of what exists.** This table is as complete as the grep that
built it, per the caveat at the top of the page. `shim/gauge.ts` is the demonstration:
`PLANNING_BAND` is listed and the `BANDS` array beside it holds eight more numbers of exactly
this class.

The message body cap is the one row that is not a single constant — it is declared independently
in three files, so changing it in one place does not change the cap.

Some of these are security limits (connection caps, refusal count, body size). Promoting them to
config means a UI could weaken them, so each needs bounds and a confirmation.

---

## Rules for any UI that writes settings

1. **Apply-on-restart.** Mount, container, driver, model, permission and allowlist changes only take
   effect after a supervisor restart. Show "applies on restart" and offer a restart action.
2. **Validate paths** with `supervise/containment.ts`. No free-text mount paths.
3. **Confirm anything that widens an agent's reach** (mounts, allowlist, `--auto`, permission mode).
4. **Same protections as the rest of `cli/web/server.ts`:** the api credential and the
   forged-`Host` refusal. `tokenMatches` against the session cookie is what refuses a caller,
   with a 401 — the capability tiers are groundwork, because only the full-capability credential
   is minted today. A loopback bind is not a boundary (containers reach it via
   `host.docker.internal`).
5. **No endpoint returns a secret value.** Add a test that fails if one does.
6. **Container boundary:** a UI must not introduce a file handoff across it (see AGENTS.md).
