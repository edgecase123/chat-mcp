---
title: Inbound Prompt
updated: 2026-11-22
covers:
  - src/supervise/index.ts
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

| decision                                         | why                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| the clause goes **last**                         | a turn acts on the end of its prompt, so the instruction sits closest to the reply                            |
| **direct messages get nothing**                  | a DM is addressed to its recipient by definition, and the clause would invite silence where an answer is owed |
| an **escalation** keeps the addressing half only | an alert or a dispatch must never be told that dropping it is acceptable                                      |
| the **bodyless fallback** is untouched           | it already says "read your inbox" rather than asking for an answer                                            |

### Why one vendor hid this for so long

**A Claude child gets the judgement from its own system prompt.** It declines
to answer a room post aimed elsewhere without being told to, so the renderer
looked correct for as long as Claude Code was the only driver. A bare
`cursor-agent` carries no such instruction, and the first live Cursor agent on
a shared room exposed it within three messages.

## Severity and addressing are orthogonal, but not independent

An alert in a room is urgent _and_ may be for someone else, so **both** render.
What changes is the clause's second half.

| kind in a room | says it is a room post | says silence is valid                                |
| -------------- | ---------------------- | ---------------------------------------------------- |
| `chat`         | yes                    | **yes**                                              |
| `dispatch`     | yes                    | **no** — "do NOT assume another member will take it" |
| `alert`        | yes                    | **no** — the same wording                            |

🛑 **An escalation may not end with permission to drop it.** `alert` is
BLOCKING by this bus's own definition and `dispatch` is a hand-off, so
"silence is a valid response" as the final line would authorise exactly the
outcome each kind exists to prevent — and the clause renders LAST, which is
why it would win.

⚠️ **Dropping the clause entirely for those two kinds is the wrong remedy.**
It restores the original defect in its loudest form: a room alert naming one
agent, answered by every member. The addressing half stays; only the
permission half goes.

`/alert`, `/dm` and `/dispatch` each accept a joined room
— the `target` case in `src/cli/ink/input/completions.ts` resolves a leading
`#` to a member room — so none of these rows is theoretical.
