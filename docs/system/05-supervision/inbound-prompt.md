---
title: Inbound Prompt
updated: 2026-11-26
covers:
  - src/supervise/index.ts
  - src/supervise/handoff.ts
---

# Inbound Prompt

What a supervised agent actually reads when a bus message wakes it, and the one
clause that stops it answering a room post meant for somebody else.

---

## One renderer, every vendor

`formatPrompt` in `src/supervise/index.ts` turns a `WakeEnvelope` into the
single string handed to the child's turn. There is no second copy: both the
Claude and the Cursor drivers receive its output, and `encodeInput` only wraps
that string in whatever shape the CLI's stdin wants.

```
🚨 ALERT — BLOCKING. …            <- banner, only for alert / dispatch
[chat-mcp] claude1 in #mcp:       <- sender, and the room when there is one

<the message body>

⚠️ This is a ROOM post. …         <- room clause, only when `to` starts with #
⚠️ This was sent to you directly …  <- DM clause, only when it does NOT
```

## The room clause

**A room post reaches every member, so most of them are not addressed to the
reader.** Nothing in the prompt used to say that answering was optional, and a
turn handed any text reads as a request to respond.

Measured on the live bus, 2026-11-22: a supervised `cursor-agent` answered two
consecutive `#mcp` posts whose first line named a different agent.

> ⚠️ This is a ROOM post. Every member received it, so it may not be addressed
> to you. Reply only if it concerns you — silence is a valid response.

**The sender and the room were already in the prompt and were not enough.** The
gap was never missing metadata.

### Three decisions worth keeping

| decision                                         | why                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| the clause goes **last**                         | a turn acts on the end of its prompt, so the instruction sits closest to the reply                    |
| **direct messages get the OTHER clause**         | a DM never gets the ROOM clause, because that one invites silence where an answer is owed — see below |
| an **escalation** keeps the addressing half only | an alert or a dispatch must never be told that dropping it is acceptable                              |
| the **bodyless fallback** is untouched           | it already says "read your inbox" rather than asking for an answer                                    |

### Why one vendor hid this for so long

**A Claude child gets the judgement from its own system prompt.** It declines
to answer a room post aimed elsewhere without being told to, so the renderer
looked correct for as long as Claude Code was the only driver. A bare
`cursor-agent` carries no such instruction, and the first live Cursor agent on
a shared room exposed it within three messages.

## One prefix rides the first prompt; the handoff gets its own turn

`formatPrompt`'s output is not always the whole string. The mount banner is
prepended once per child and then never again. The handoff pointer is NOT a
prefix at all — it is the supervisor's own first queued prompt.

|       | mount banner                                       | handoff pointer                        |
| ----- | -------------------------------------------------- | -------------------------------------- |
| shape | a prefix on the first inbound prompt               | its own queued prompt                  |
| when  | the first bus message that wakes a fresh container | at child start, before any bus message |
| gate  | containerized AND a fresh session                  | a fresh session, EITHER mode           |

🛑 **THE HANDOFF POINTER SHIPPED AS A PREFIX FOR ONE GATE RUN, AND IT BROKE TWO
INVARIANTS AT ONCE.** Both were caught by a single assertion in
`child-output-logged.test.ts`:

- **The `alert` banner stopped being first.** A turn is handed ONE string, and
  the banner is the only thing carrying "handle this before anything queued
  behind it" — so a BLOCKING message opened with a paragraph about a file.
- **It displaced the message body out of `excerptForLog`'s window**, which is
  the exact defect `LOG_EXCERPT_LIMIT` was raised from 80 to 200 to fix.

**The mount banner is a few short lines and survives both. A paragraph has to
be its own turn.**

🛑 **THE GATES ARE ALSO NOT THE SAME, AND COPYING ONE BREAKS THE OTHER.** The
mount banner is container-only, because a host agent has no mounts. The handoff
pointer is not, because a host agent has a project directory and therefore a
handoff. `test/supervise/handoff-pointer.test.ts` pins both arms, plus a resume
control and the alert-banner regression above.

### The handoff file

lee ruled on 2026-11-26 that an agent keeps its own continuity in a file it
both reads and writes:

| mode     | the path the agent is given                                           |
| -------- | --------------------------------------------------------------------- |
| `docker` | `/work/HANDOFF.md` — derived from the project bind, never spelled out |
| `host`   | `HANDOFF.md` inside the agent's resolved project directory            |

**The agent is the routine writer, not the only one.** `/work` is a read-write
bind of the host project directory, so anything on the host that writes
`<projectDir>/HANDOFF.md` reaches the container immediately — an operator can
seed a handoff, which is what #463's own item 2 asked for.

🛑 **AN EARLIER VERSION OF THIS PAGE SAID "NOTHING ELSE CAN", AND THAT WAS
FALSE.** It argued from `docker cp` having zero hits in `src/`, which is true
and does not imply exclusivity — a bind mount needs no `docker cp`. The prompt
the agent reads no longer claims it either, because an agent told it is the
only writer has no reason to expect the file to have changed under it.
Raised by claude2 on PR 469.

🛑 **TWO EARLIER DESIGNS FOR THE SAME FEATURE ARE CLOSED. Do not revive
either.**

| rejected                            | why it cannot work                                      |
| ----------------------------------- | ------------------------------------------------------- |
| a mounted `local-context` directory | unreachable from inside the container                   |
| the container's own `/tmp`          | `docker run --rm` destroys it when the supervisor stops |

`/work` is a bind of the host project directory, so a handoff written there
survives a clear, a container rebuild and a supervisor restart.

⚠️ **THE POINTER IS STILL NOT HANDED TO THE CHILD AT SPAWN.** It is the
supervisor's first queued prompt, so every child that starts gets it — but
closing the gap properly means telling the child at spawn time rather than
spending a turn on it. **That is its own ticket, not this one.**

## Severity and addressing are orthogonal, but not independent

An alert in a room is urgent _and_ may be for someone else, so **both** render.
What changes is the clause's second half.

| kind in a room | says it is a room post | says silence is valid                                         |
| -------------- | ---------------------- | ------------------------------------------------------------- |
| `chat`         | yes                    | **yes**                                                       |
| `dispatch`     | yes                    | **no** — "either take it or say in the room that you are not" |
| `alert`        | yes                    | **no** — the same wording                                     |

🛑 **An escalation may not end with permission to drop it.** `alert` is
BLOCKING by this bus's own definition and `dispatch` is a hand-off, so
"silence is a valid response" as the final line would authorise exactly the
outcome each kind exists to prevent — and the clause renders LAST, which is
why it would win.

⚠️ **Dropping the clause entirely for those two kinds is the wrong remedy.**
It restores the original defect in its loudest form: a room alert naming one
agent, answered by every member. The addressing half stays; only the
permission half goes.

🛑 **The escalation wording asks for something OBSERVABLE, and names only a
verb the child is granted.** "Do not assume another member will take it"
forbade a belief and emitted nothing, so no later reader could tell whether
anyone complied. Saying so in the room uses `room_send`, which
`DEFAULT_ALLOWED` grants.

⚠️ **Telling it to CLAIM the work would read better and would not work.**
`mcp__chat__claim` is registered as a tool but appears in no allowlist in this
tree, so that instruction buys a denial and spends a turn. The principle is
claude2's, from PR 412; the verb had to change to a granted one.

`/alert`, `/dm` and `/dispatch` each accept a joined room
— the `target` case in `src/cli/ink/input/completions.ts` resolves a leading
`#` to a member room — so none of these rows is theoretical.

## The direct-message clause

**A DM used to carry no reply instruction at all, so it was instructed LESS
than a room post.** The room clause was deliberately withheld from a DM, and
nothing was put in its place.

Measured on the live bus, 2026-11-26: lee DM'd a supervised `cursor-agent`
"Are you available?". The child's own thinking said _"No tools are needed"_,
it answered in prose, and the sender received nothing. Both transcripts read
as a completed turn.

> ⚠️ This was sent to you directly, so an answer is owed. Deliver it with
> `send` — prose alone stays in your own transcript and reaches nobody.

🛑 **The two clauses are exclusive.** A room post says silence is valid; a DM
says an answer is owed. Rendering both would be a contradiction the reader
resolves however it likes.

🛑 **It names `send`, and only a verb the child is granted** —
`src/supervise/allowlist.ts` carries `mcp__chat__send`. This is the same trap
the room clause records for `claim`: naming an ungranted tool buys a denial
instead of a reply.

⚠️ **The bodyless fallback still gets nothing.** It already says "read your
inbox", so telling it to answer a body it was never handed would be wrong.

🛑 **A child started with `--no-reply` gets no clause at all.** `buildGrant`
returns `undefined` for it, so there is no `send` to name and the clause would
be an instruction the child cannot follow.

### The clause and the notice are ONE decision

`formatPrompt` returns `{ text, owedTo }`. One expression sets both, so a
prompt that was never told to reply can never have its silence reported.

```
owed = not a room post
       AND the child holds `send`
       AND the sender is named
       AND the sender is not `system`
```

`system` is excluded because its context nudge arrives as a DM, so a notice
owed to it was addressed back to `system` and reached nobody.

The body precondition is NOT in that expression. It lives in the bodyless
early return above, which returns before `owed` is computed — repeating it
read as a guard and killed no mutant.

## When the reply is lost anyway, the SENDER is told

`silentReplyWarning` in `src/supervise/silent-reply.ts` already detected this
exact turn — prose produced, no `send` called — and its only output was a line
in the supervisor's own log. **The person waiting reads chat, not a terminal**,
so a working detector cost a hand diagnosis.

A turn that was owed a reply and delivered none now DMs the sender:

```
from   dao.SYSTEM_HANDLE, never the agent's own handle
to     the peer who sent the DM
body   "<agent> answered your message inside its own transcript only — <verdict>"
```

| decision                                         | why                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `SYSTEM_HANDLE` is the sender                    | sending as the agent puts words in its mouth, and a DM from a handle the supervisor drives can re-wake it                         |
| the verdict text is `silentReplyWarning`'s       | its two branches ARE the discrimination; a paraphrase is where "UNKNOWN" drifts into an accusation                                |
| **a room post notifies nobody**                  | the room clause told that reader silence was valid, so announcing its silence contradicts the bus                                 |
| **a DM the child cannot answer notifies nobody** | with no `send` granted the child was never told to reply, so reporting its silence is an accusation over a reply nobody asked for |
| **a bodyless DM notifies nobody**                | the fallback prompt says "read your inbox" and asks for no answer                                                                 |
| a send that cannot land is logged, never thrown  | the turn itself completed; a failed notice must not fail it                                                                       |

🛑 **UNKNOWN stays a third state.** A tool call the driver could not name may
have BEEN the send, so that case says delivery is UNKNOWN rather than claiming
nobody received it.
