import { join } from "node:path";
import type { SandboxMode } from "./vendor.js";
import { CONTAINER_PROJECT_DIR } from "./drivers/containerized.js";

/**
 * The bus rules a supervised agent is handed, as a file beside its handoff.
 *
 * lee, 2026-11-26, naming the gap after a containerized Cursor agent had to be
 * taught the rules by two siblings in chat:
 *
 * > *"the agent needs basic rules set out inside their AGENTS.md file or a
 * > file it points to"*, then the minimum: *"connect to chat as we've done and
 * > an etiquette file or blurb"*, with the example
 * > *"don't unnecessarily acknowledge chat messages"*.
 *
 * 🛑 AUTHORSHIP WAS NEVER THE GAP. DELIVERY IS. `AGENTS.md` already carried the
 * tag rule and the claim rule, both agents had it on disk all day, and between
 * them they made 58 untagged room posts — 1 compliant out of 59, measured off
 * `chat.db`. A 512-line file nobody opens changes no behaviour.
 *
 * 🛑 A FILE, NOT MORE PREAMBLE TEXT. Turn one is already contested: PR 469's
 * pointer turn consumed the turn a context-gate restart needed for its own
 * notice, and the suite went red at 33 failures. A pointer costs one sentence
 * and the rules cost none.
 *
 * ⚠️ THE RULES HERE ARE GENERIC ROOM HYGIENE, AND THAT IS WHY THEY MAY SHIP IN
 * A PUBLIC REPO. `chat-mcp` is public and `leagues` is private, so the
 * accessibility rules that govern HOW to write for lee stay local in both. Do
 * not move them in here.
 */

/** The one spelling of the file's name, in both modes. */
export const ETIQUETTE_FILENAME = "ETIQUETTE.md";

export interface EtiquetteRule {
  /** The instruction, in the imperative, as the agent will read it. */
  readonly rule: string;
  /** What it costs when broken. An agent given no reason re-derives one. */
  readonly why: string;
  /**
   * Text that must appear VERBATIM in `AGENTS.md`.
   *
   * 🛑 THE DRIFT GUARD, AND IT IS THE WHOLE REASON THIS FIELD EXISTS. Two
   * copies of a rule drift, and the drifted copy is the one in the sandbox
   * where nobody reads it. `etiquette-agents-md.test.ts` fails if an anchor
   * stops matching, so a rule reworded in `AGENTS.md` cannot leave this file
   * serving the old wording.
   */
  readonly anchor: string;
}

/**
 * Every rule the file carries, ranked by what it costs lee when broken.
 *
 * 🛑 RANKED, NOT ALPHABETICAL OR CHRONOLOGICAL. An agent reading a flat list
 * does its own prioritising and gets it wrong; the order is the instruction.
 *
 * ⚠️ DELIBERATELY SHORT. Every entry owes an `anchor` in `AGENTS.md`, so a
 * fourth rule is a fourth thing to keep in sync. The bar for adding one is a
 * measured cost, not a good idea.
 */
export const ETIQUETTE_RULES: readonly EtiquetteRule[] = [
  {
    rule: "Open every room post with a tag naming who it is for: `#lee:`, `#claude1:`, or `#here:` for everyone. The trailing colon is what separates a tag from a room name, so it is not optional.",
    why: "An untagged post reads as addressed to everyone, so every agent answers it and the human pays several times for one answer.",
    anchor: "TAG WHO YOU ARE ADDRESSING. EVERY ROOM POST.",
  },
  {
    rule: "Do not acknowledge a message unless your reply changes something for the reader. Silence already means received.",
    why: "An acknowledgement carries no information and still costs the reader a message. Four in a row cost four reads and taught nobody anything.",
    anchor: "DO NOT ACKNOWLEDGE UNNECESSARILY.",
  },
  {
    rule: "Post only when a message names you, or when you hold information the reader cannot get anywhere else. Do not post to say you are staying silent.",
    why: "Every member receives every room post, so a relay arriving is not a request for your reply. One agent spent 58% of its turns producing output nobody received.",
    anchor: "POST ONLY WHEN YOU ARE NAMED",
  },
  {
    rule: "One short post, never a thread. A second post is justified only when its first line names what it changes about the first.",
    why: "Four posts carrying one fact between them cost the reader four reads for one piece of information.",
    anchor: "ONE SHORT POST, NEVER A THREAD.",
  },
  {
    rule: "Before answering a question that names no agent, `claim` the resource `answer-<message id>`. A question tagged for you alone needs no claim.",
    why: "Two agents answer the same untagged question within ten seconds, so reading the room first cannot prevent it. The claim is the only thing that serialises it.",
    anchor: "CLAIM `answer-<id>` BEFORE REPLYING TO lee",
  },
  {
    rule: "Write your handoff file for state a replacement would have to resume, and when you are told to externalize before a restart. It is not a running log.",
    why: "A handoff rewritten every turn costs a turn's attention and tells the next reader nothing the room does not already hold.",
    anchor: "THE HANDOFF FILE IS FOR STATE THAT MUST SURVIVE A RESTART.",
  },
];

/**
 * The etiquette path as the AGENT will see it.
 *
 * 🛑 DERIVED FROM THE MOUNT AND NOT SPELLED OUT, for the reason
 * `handoffPathFor` is: a second literal `/work` drifts from the bind silently,
 * and the only symptom is an agent told to read a path nothing is mounted at.
 *
 * 🛑 AND IT IS NOT `join` ON THE CONTAINER ARM. The container is Linux
 * whatever the host is, so `join` would answer a Windows host with a backslash
 * the container cannot resolve.
 */
export function etiquettePathFor(
  mode: SandboxMode,
  projectDir: string,
): string {
  if (mode === "docker")
    return `${CONTAINER_PROJECT_DIR}/${ETIQUETTE_FILENAME}`;

  return join(projectDir, ETIQUETTE_FILENAME);
}

/**
 * Where the SUPERVISOR writes the file, which is NOT where the agent reads it.
 *
 * 🛑 TWO DIFFERENT PATHS FOR ONE FILE, AND CONFLATING THEM IS SILENT. The
 * write happens on the HOST, into the project directory; the container sees
 * that same byte at `/work/ETIQUETTE.md` because the project bind is
 * read-write. Writing to `etiquettePathFor("docker", …)` would try to create
 * `/work/...` on the host, which is a different filesystem and usually a
 * permission error — and the only symptom is an agent pointed at a file that
 * is not there.
 */
export function etiquetteHostPath(projectDir: string): string {
  return join(projectDir, ETIQUETTE_FILENAME);
}

/**
 * The one sentence the preamble spends on the rules.
 *
 * 🛑 A SENTENCE, NOT THE RULES THEMSELVES. Turn one is contested — PR 469's
 * pointer turn consumed the turn a context-gate restart needed, and the suite
 * went red at 33 failures. The file costs the agent a read it chooses; inlined
 * rules cost every agent a turn it did not.
 *
 * ⚠️ IT MUST NOT CLAIM THE FILE EXISTS UNCONDITIONALLY, for the reason
 * `handoffPreamble` must not: the write is wrapped, so a read-only project
 * directory leaves the sentence true and the file absent.
 */
export function etiquetteSentence(path: string): string {
  return (
    `The bus rules you work under are in \`${path}\` — ` +
    `read it before your first room post if it is there.`
  );
}

/**
 * How to reach the bus, which is the other half of lee's minimum.
 *
 * ⚠️ IT CLAIMS NO SETUP STEP, BECAUSE THERE IS NONE. The prelude writes the
 * MCP config before the agent starts, so an instruction to configure anything
 * would send the agent looking for a file it must not touch.
 *
 * 🛑 IT NAMES `inbox` AND `room_inbox` AS THE READ PATH ON PURPOSE. A wake
 * payload can arrive truncated, and an agent that answers the payload instead
 * of the message disputes things the cut removed.
 */
function connectSection(): string {
  return [
    "## Connecting to chat",
    "",
    "The `chat` tools are already wired for you. There is nothing to configure.",
    "",
    "- `whoami` tells you your own handle and who your peers are.",
    "- `inbox` reads your direct messages. `room_inbox` reads your rooms.",
    "- **Read those two directly rather than trusting a wake notification.** A notification can arrive truncated, and answering the truncated copy means disputing words that were only cut.",
    "- `room_join` joins a room. `room_send` posts to one, and `send` is a direct message.",
    "- `claim` takes an exclusive hold on a shared resource and `release` gives it up. `claims` lists what everyone holds.",
  ].join("\n");
}

/**
 * The whole file, as the supervisor writes it.
 *
 * ⚠️ REGENERATED ON EVERY START, so an operator edit does not survive. That is
 * deliberate: the rules have one source, and a hand-edited copy in a scratch
 * directory is how the sandbox came to hold the stale wording.
 */
export function etiquetteBody(): string {
  const rules = ETIQUETTE_RULES.map(
    ({ rule, why }, i) => `${i + 1}. **${rule}**\n   ${why}`,
  ).join("\n\n");

  return [
    "# How to behave on this bus",
    "",
    "Generated by the supervisor. Edits here are overwritten on the next start.",
    "",
    "## Etiquette, most costly first",
    "",
    rules,
    "",
    connectSection(),
    "",
  ].join("\n");
}
