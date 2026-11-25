# Starting a contained agent

How an operator starts a supervised agent from the browser dashboard, why the
route refuses in the same order the spawn does, and where the child's output
goes.

## The route

| route               | method | capability | what it does                                      |
| ------------------- | ------ | ---------- | ------------------------------------------------- |
| `/api/agents/start` | POST   | `admin`    | Hands one handle's supervisor off to run detached |

`admin`, because it runs an agent CLI on this machine. That is a larger grant
than any message a `write` credential can send.

**Docker handles only**, on lee's ruling of 2026-11-25. A host start has no
container plan to approve, so there is no consent step anywhere in it — one
click would be an agent holding the operator's whole filesystem and logins.

## It answers 202, not 200

The supervisor is not listening when the reply is written. It has been handed
off, which is a different claim from "it is up". The card re-reads
`/api/agents/live` after either outcome, and that is what makes the Start
button disappear.

## The refusal order is the contract

The four refusals are in `startSupervisor`'s own order, and mirroring it is the
point. A route that answered a different order would name a blocker the spawn
would not have reached first — so the operator fixes something that was never
the reason, and earns a second refusal.

```
src/supervise/index.ts:293  refuseIfSupervisorLive   409 already-running
                      :356  requireVendorToken       409 no-vendor-token
                      :364  confirmVerdict           409 plan-unconfirmed
                      :392  dirsFor                  409 no-project-dir
```

| `error`              | status | `message`                                         |
| -------------------- | ------ | ------------------------------------------------- |
| `bad-handle`         | 400    | `handle must be a non-empty string`               |
| `not-registered`     | 404    | names the handle, from `containerPlanFor`         |
| `not-docker`         | 409    | names the handle, from `containerPlanFor`         |
| `vendor-unspawnable` | 409    | the vendor resolution's own throw                 |
| `already-running`    | 409    | `<handle> already has a supervisor`               |
| `no-vendor-token`    | 409    | `missingVendorTokenMessage(vendor)`, **verbatim** |
| `plan-unconfirmed`   | 409    | `approve the container plan first`                |
| `no-project-dir`     | 409    | `set a project directory for <handle>`            |

- **`error` is a token and `message` is the sentence.** The card branches on
  the token and renders the sentence, so neither has to be parsed out of the
  other.
- **`no-vendor-token` forwards the vendor's own message unchanged.** It already
  carries `authSetupHint`, which is the remedy. A paraphrase would be a second
  copy of the rule, free to drift from the terminal path's.
- **`already-running` is rewritten rather than forwarded.** The thrown message
  names the socket path, which is a detail of this machine and not of the
  refusal.
- **`legacy` and `changed` plans both answer `plan-unconfirmed`**, exactly as
  the spawn refuses all three non-confirmed verdicts. Which one it is belongs
  to `GET /api/agents/plan`, whose whole job is to say so.

## Every precondition is answered before the spawn

The spawn is detached, so a throw after that point lands in the handle's log
file — where the operator who clicked the button will never see it. The route
therefore resolves all four itself and only then hands off.

## The child's output

`startDetachedSupervisor` in `src/supervise/detached.ts` points the child's
stdout and stderr at `logs/<handle>.log` under the state directory, and returns
that path in the reply.

- **Detached, never in-process.** The web server restarts whenever the operator
  edits a credential or the port moves. An in-process supervisor would die with
  it, taking the agent's container along.
- **stdin is closed, not inherited.** The terminal confirm prompt reads stdin,
  and a child blocking on a prompt nobody can answer looks hung.
- **`CHAT_MCP_HOME` is resolved and passed, not left to inheritance.**
  `stateDir()` refuses its default under the test runner and a child inherits
  `NODE_TEST_CONTEXT` — so an unset variable would make a browser click fail
  with a message about tests.
- **Appended, at 0600.** A restart keeps the run before it, and the first lines
  carry the child's allowed-tool list and its socket path.

## Related

- [stopping-agents.md](stopping-agents.md) — the other half, and where the live
  list comes from
- [state-directory.md](../03-infrastructure/state-directory.md) — `logs/` and
  every other entry
