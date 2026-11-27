import { writeFileSync } from "node:fs";
import type { AgentChild, SpawnOptions } from "./child.js";
import { assertDeclaresCapabilities } from "./child.js";
import type { VendorSpawn } from "./vendor.js";
import { selectionFor } from "./selection.js";
import { spawnOnHost } from "./drivers/host.js";
import {
  spawnContainerized,
  runDependencyInstall,
  DEFAULT_SHUTDOWN_GRACE_SECONDS,
} from "./drivers/containerized.js";
import { resolveOverrideFor } from "./overrideStore.js";
import { TurnQueue } from "./turn-queue.js";
import {
  WakeListener,
  refuseIfSupervisorLive,
  type WakeAck,
  type WakeEnvelope,
} from "./socket.js";
import { RateLimitGate } from "./rate-limit.js";
import { openDb } from "../storage/db.js";
import { notifyPeer } from "../notify/bus.js";
import * as dao from "../storage/dao.js";
import {
  availableBuiltins,
  childHandleFor,
  defaultAllowed,
  type ChildGrant,
} from "./grant.js";
import { createCanReplyPublisher } from "./can-reply.js";
import { announceChildExit } from "./exit-event.js";
import {
  newTurn,
  observe,
  observeToolCall,
  silentReplyWarning,
} from "./silent-reply.js";
import { dirsFor } from "./projects.js";
import { allowlistWith, resolveCwd } from "./allowlist.js";
import { handoffPathFor, handoffPreamble } from "./handoff.js";
import {
  etiquetteBody,
  etiquetteHostPath,
  etiquettePathFor,
  etiquetteSentence,
} from "./etiquette.js";
import { commandFromGrant, grantFor, grantVariants } from "./denial.js";
import { writeClaudeMcpConfig } from "./drivers/claude.js";
import {
  describeChildOutput,
  describeTurnResult,
  excerptForLog,
} from "./drivers/claude-events.js";
import { openHostBus, type HostBus } from "./host-bus.js";
import { applyContextReport, contextPercent } from "../shim/gauge-report.js";
import { resolveContextGate } from "../storage/context-gate.js";
import type { ContextSnapshot } from "./context-gauge.js";
import { createActivityReporter } from "./activity.js";
import { describeContextGauge } from "./context-gauge.js";

/**
 * The supervisor: it owns the loop the harness used to own.
 *
 * A message arriving no longer needs the host to convert a background
 * process's stdout into a turn. This process listens, and writes into a
 * long-lived child's stdin.
 */
export interface SupervisorOptions extends SpawnOptions {
  readonly handle: string;
  /**
   * Refuse to dispatch at or above this window utilization, 0..1.
   *
   * 🛑 On a subscription `total_cost_usd` is notional — the real currency is
   * the usage window, and `overageStatus: "rejected"` means a full window
   * REFUSES requests rather than billing for them. Running out stops work.
   */
  readonly utilizationCeiling?: number;
  /**
   * Whether the supervised child may answer on the bus. Default true.
   *
   * 🛑 `false` makes the supervisor a DOORBELL — it wakes an agent that cannot
   * respond. That was the shipped behaviour and it is not a sensible default.
   */
  readonly reply?: boolean;

  /**
   * Delete this handle's `agents` row when `stop()` runs. Default false.
   *
   * 🛑 OPT-IN, BECAUSE A REAL SESSION STOPPING IS NOT THE SAME EVENT. The
   * handle-claim path is built on the row being present, so a supervisor that
   * always deregistered would free a handle a live operator still holds.
   * Throwaway harnesses opt in; `chat-mcp supervise` does not.
   */
  readonly ephemeral?: boolean;

  /**
   * How long to wait before re-publishing `can_reply` to an absent row (#475).
   *
   * ⚠️ IT EXISTS FOR THE TEST, not for an operator. The child's `agents` row
   * is written by the shim at registration, so the supervisor's first write
   * lands on nothing and has to be retried.
   */
  readonly canReplyRetryMs?: number;

  /** Allowlist override. Default `DEFAULT_ALLOWED` — lee's narrow list. */
  readonly allowedTools?: readonly string[];

  /**
   * Directories the child may touch beyond its cwd. Default
   * `DEFAULT_EXTRA_DIRS`.
   *
   * 🛑 THIS, NOT THE ALLOWLIST, IS WHAT CONTAINS THE AGENT. Measured.
   */
  readonly extraDirs?: readonly string[];

  /**
   * Which agent CLI to drive. Default `claude`.
   *
   * An unknown name THROWS and names what this build has, because a silent
   * fallback would mean asking for Cursor and getting Claude.
   */
  readonly driver?: string;

  /**
   * Run this handle's child inside a container. Requires a token on file
   * (`chat-mcp auth set-token`) and a confirmed plan
   * (`chat-mcp supervise <handle> --container` prompts for this once).
   */
  readonly container?: boolean;

  /**
   * Which vendor's CLI this handle spawns. Resolved by the CALLER (the CLI
   * imports `adapters/index.js`'s `spawnFor`; `supervise/` never does — see
   * the layering rule in `supervise/drivers/index.ts`).
   */
  readonly vendor: VendorSpawn;

  /** Injected so the supervisor is testable without touching the real bus. */
  readonly db?: Parameters<typeof dao.insertApproval>[0];

  /** Injected so the supervisor is testable without spawning or spending. */
  readonly spawnChild?: (opts: SpawnOptions) => AgentChild;

  /**
   * The pre-bind dependency install, injectable for the same reason.
   *
   * 🚨 DEFAULTS TO A NO-OP WHEN `spawnChild` IS INJECTED, AND THAT COUPLING IS
   * THE POINT. Installing dependencies is part of creating a containerized
   * child, so a caller that replaced child creation has replaced this too.
   *
   * Two independent seams were the first cut and they were wrong: three tests
   * injected `spawnChild`, inherited the real install, and shelled out to a
   * real `docker run`. CI failed on a missing image; the author's host HAD the
   * image, so the install really ran and left 40 volumes behind. Caught by
   * claude1 on PR 259 against a local suite that read green.
   *
   * ⚠️ PASS IT EXPLICITLY to assert the install happened. The default only
   * decides what an uninjected caller gets.
   */
  readonly installDeps?: (opts: SpawnOptions) => void;
  readonly log?: (line: string) => void;
}

export interface Supervisor {
  readonly socketPath: string;
  /** Prompts accepted but not yet written to the child. */
  readonly queueDepth: number;
  /** Messages accepted but WITHHELD because the usage window is too full. */
  readonly heldDepth: number;
  /** One line of window utilization, never dollars. */
  rateLimits(): string;
  /**
   * Called every time the child finishes a turn.
   *
   * 🛑 EXPOSED SO NOBODY HAS TO TIME IT. The supervisor already knew, and
   * logged `← turn complete` without telling anyone, so a caller waiting for
   * the agent to stop had to guess with a quiet-period timer — shorter than a
   * routine model pause. Raised by claude1 on PR 43.
   */
  onTurnEnd(cb: () => void): void;
  /**
   * `'now'` (default) kills immediately, matching every existing caller.
   * `'graceful'` sends `SHUTDOWN_NOTICE` first and waits out the configured
   * grace period for the current turn to end (#149) — the CLI's SIGINT/
   * SIGTERM handler is the one caller that wants this.
   */
  stop(mode?: "graceful" | "now"): Promise<void>;
  /**
   * Called once this supervisor has stopped, however the stop was triggered.
   *
   * 🛑 THE CLI'S ONLY EXIT SIGNAL FOR A BUS-DELIVERED STOP. `stop()` closes the
   * socket and kills the child but cannot exit the host process, so without
   * this the `supervise` process outlives its own stop and the operator sees
   * nothing happen — the #136 symptom, reproduced by the fix for it.
   */
  onStopped(cb: () => void): void;
}

/** How an arriving message is presented to the agent, and who is owed a reply. */
export function formatPrompt(
  envelope: WakeEnvelope,
  canSend: boolean,
): { text: string; owedTo?: string } {
  const from = envelope.from || "unknown";
  const body = envelope.body?.trim();
  const inRoom = envelope.to.startsWith("#");
  const where = inRoom ? ` in ${envelope.to}` : "";

  // 🛑 An `alert` is BLOCKING by this bus's own definition. Rendering it the
  // same as a chat message loses the urgency at the layer built to deliver it
  // faster, so the escalation is in the prompt text and not left to the
  // agent to infer from a field it may not read.
  const banner =
    envelope.kind === "alert"
      ? "🚨 ALERT — BLOCKING. This was sent as high-severity; handle it before anything queued behind it.\n\n"
      : envelope.kind === "dispatch"
        ? "📋 DISPATCH — a task hand-off, not a status update.\n\n"
        : "";

  if (!body) {
    // 🛑 No body means this came through the FALLBACK file path, which
    // overwrites and carries no payload. Say so rather than inventing one —
    // the agent must know to go and read the bus itself.
    return {
      text: `${banner}[chat-mcp] ${from}${where} sent you something (id ${envelope.id}). The wake carried no body, so read your inbox.`,
    };
  }

  // 🛑 ONE EXPRESSION DECIDES BOTH THE CLAUSE AND THE NOTICE. They were
  // computed apart, so a `--no-reply` DM was told nothing about replying and
  // still had its silence reported — an accusation over a reply nobody asked
  // for, which is #417's class and the one #472 named avoiding.
  //
  // 🛑 BELOW THE BODYLESS RETURN ON PURPOSE. That return is the only place
  // the body precondition lives; repeating it here read as a guard and killed
  // no mutant.
  //
  // 🛑 `system` IS EXCLUDED. Its context nudge is a DM, so a notice owed to it
  // was addressed back to `system` and reached nobody. Measured on a live turn.
  const owed =
    !inRoom &&
    canSend &&
    !!envelope.from &&
    envelope.from !== dao.SYSTEM_HANDLE;

  const clause = inRoom
    ? roomClause(inRoom, envelope.kind)
    : owed
      ? directClause()
      : "";

  return {
    text: `${banner}[chat-mcp] ${from}${where}:\n\n${body}${clause}`,
    ...(owed ? { owedTo: envelope.from } : {}),
  };
}

/**
 * Told to a room reader: answering is optional.
 *
 * 🛑 A ROOM POST REACHES EVERY MEMBER, SO MOST ARE NOT ADDRESSED TO THE
 * READER. The sender and the room were already in the prompt and were not
 * enough — a supervised `cursor-agent` answered two consecutive `#mcp` posts
 * that named another agent in their first line.
 *
 * 🛑 LAST, SO IT IS THE CLOSEST INSTRUCTION TO THE REPLY. A turn is handed a
 * single string and acts on the end of it. That is also why an escalation may
 * not end with permission to stay silent — see the kind split below.
 *
 * ⚠️ NOT ADDED TO THE BODYLESS FALLBACK, WHICH SAYS "READ YOUR INBOX". That
 * path never asks for an answer, so the clause would refuse a request it did
 * not make.
 */
function roomClause(inRoom: boolean, kind: WakeEnvelope["kind"]): string {
  if (!inRoom) return "";

  // 🛑 AN ESCALATION KEEPS THE ADDRESSING HALF AND LOSES THE PERMISSION HALF.
  // `alert` is BLOCKING by this bus's own definition and `dispatch` is a
  // hand-off, so ending either with "silence is a valid response" would
  // authorise the one outcome each kind exists to prevent — and this clause
  // renders LAST, which is exactly why it would win.
  //
  // ⚠️ DROPPING THE WHOLE CLAUSE HERE WOULD RESTORE THE MEASURED DEFECT IN ITS
  // LOUDEST FORM: a room alert naming one agent, answered by every member.
  // Raised by claude2 on PR 412; the split is the answer to it.
  //
  // 🛑 IT ASKS FOR SOMETHING OBSERVABLE, AND ONLY FOR A VERB THE CHILD HAS.
  // "Do not assume another member will take it" forbade a belief and emitted
  // nothing, so no later reader could tell whether anyone complied. Saying so
  // in the room uses `room_send`, which `DEFAULT_ALLOWED` grants. CLAIMING it
  // would read better and `mcp__chat__claim` is in no allowlist in this tree,
  // so that instruction would buy a denial.
  if (kind === "alert" || kind === "dispatch") {
    return (
      "\n\n⚠️ This is a ROOM post, so every member received it. If it names " +
      "someone else, leave it to them. If it names nobody, either take it or " +
      "say in the room that you are not — do not leave it unanswered."
    );
  }

  return (
    "\n\n⚠️ This is a ROOM post. Every member received it, so it may not be " +
    "addressed to you. Reply only if it concerns you — silence is a valid " +
    "response."
  );
}

/**
 * Told to a DM reader: an answer is owed, and prose is not one.
 *
 * 🛑 A DM USED TO CARRY NOTHING, SO IT WAS INSTRUCTED LESS THAN A ROOM POST.
 * Measured 2026-11-26: a supervised `cursor-agent` was DM'd "Are you
 * available?", reasoned *"No tools are needed"*, answered in prose, and the
 * sender received nothing. Both transcripts read as a completed turn.
 *
 * 🛑 IT NAMES `send`, AND ONLY A VERB THE CHILD HAS — `allowlist.ts` grants
 * `mcp__chat__send`. Naming a tool no allowlist grants buys a denial instead
 * of a reply, which is the trap this file records for `claim`.
 *
 * ⚠️ NOT APPENDED TO A ROOM POST. `roomClause` already tells a room reader
 * that silence is allowed, and saying both would be a contradiction the
 * reader resolves however it likes.
 */
function directClause(): string {
  return (
    "\n\n⚠️ This was sent to you directly, so an answer is owed. Deliver it " +
    "with `send` — prose alone stays in your own transcript and reaches nobody."
  );
}

/**
 * The child's bus identity and tool grant, or undefined when replies are off.
 *
 * Derived from the supervisor's handle rather than configured, so the two can
 * never be made equal by forgetting a flag — a child sharing the supervisor's
 * handle consumes the deliveries meant for it (chat-mcp#35).
 */
function buildGrant(
  opts: SupervisorOptions,
  dirs: readonly string[],
): ChildGrant | undefined {
  if (opts.reply === false) return undefined;

  const handle = childHandleFor(opts.handle);

  const allowed = opts.allowedTools ?? defaultAllowed(dirs);

  return {
    handle,
    configPath: writeClaudeMcpConfig(handle),
    allowed,
    available: availableBuiltins(allowed),
    extraDirs: [...dirs],
  };
}

export async function startSupervisor(
  opts: SupervisorOptions,
): Promise<Supervisor> {
  // 🛑 FIRST STATEMENT, BEFORE ANYTHING WRITES OR SPAWNS. lee ruled on
  // 2026-11-11 that a second supervisor refuses rather than taking over.
  // Refusing here rather than at the `bind` below keeps two destructive steps
  // out of the rejected path: the child's MCP config, which is written per
  // handle and would clobber the live supervisor's, and the containerized
  // spawn's `docker rm -f` (#154).
  await refuseIfSupervisorLive(opts.handle);

  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  // 🛑 ONLY THE MODE IS TAKEN FROM HERE. `opts.vendor` arrives already
  // resolved to a `VendorSpawn` by the caller that imports `adapters/`, so a
  // library caller naming a vendor object keeps it; `agents.json` supplies the
  // mode this handle was registered with when no flag tightened it.
  const selection = selectionFor(opts.handle, {
    driver: opts.driver,
    container: opts.container,
  });

  // 🛑 THE MODE IS THE GATE, NOT A DRIVER-NAME STRING. `resolveDriver` already
  // folds `--driver docker-claude` and `--container` into one `SandboxMode`,
  // so every container-only decision in this function (mount banner included)
  // reads `selection.mode` rather than re-deriving container-ness from a name
  // a second vendor could spell differently.
  const isContainerSpawn = selection.mode === "docker";

  /**
   * #222's grant, read ONCE per supervisor and injected at the spawn seam
   * below.
   *
   * 🛑 RESOLVED HERE, NOT PER SPAWN, BECAUSE A RESTART MUST NOT BE ABLE TO
   * REFUSE. A malformed or dangling override throws, and `doRestart` kills the
   * child before it calls `spawnFn` — so a throw at spawn time leaves the
   * handle with no agent at all and no remedy short of restarting the
   * supervisor. Refused at START it is loud and nothing is running yet. Same
   * reasoning as the cold-install ordering below.
   *
   * ⚠️ THE COST IS THAT AN EDIT MID-SESSION NEEDS A SUPERVISOR RESTART, not
   * just an agent restart. Accepted rather than fixed: the alternative trades
   * a stale limit for a handle that cannot come back.
   *
   * 🛑 RESOLVED FOR EVERY MODE, NOT ONLY A CONTAINER ONE. A host handle with
   * an override file has written something no spawn can honour, and reading
   * it only in the branch that consumes it means that file is refused for one
   * mode and ignored in silence for the other.
   */
  const containerOverride = resolveOverrideFor(opts.handle);

  // 🛑 SAID OUT LOUD, BECAUSE A HOST SPAWN CANNOT HONOUR ANY OF THESE KEYS.
  // Every key is a `docker run` flag, so a host handle's override file sits on
  // disk looking effective while the agent runs with no limit on it. Refusing
  // the start would be worse: it would make a mode switch break a handle that
  // was configured for the mode it is going back to. Raised by claude2
  // reviewing PR 337.
  if (!isContainerSpawn && containerOverride) {
    log(
      `"${opts.handle}" has a container override on file and is not running ` +
        "in a container, so none of it applies to this agent",
    );
  }

  if (isContainerSpawn) {
    const { requireVendorToken } = await import("./auth.js");
    const { confirmVerdict, describeChanges } = await import("./container.js");
    const { buildConfirmPlan } = await import("./confirmPlan.js");

    // Refused at START, for the same reason the override is: a throw at spawn
    // time leaves the handle with no agent and no remedy.
    // The value is discarded: the driver reads it again when it builds the
    // plan. This is the early refusal, not the injection.
    requireVendorToken(opts.vendor);
    // 🛑 COMPARED, NOT LATCHED. A per-handle boolean meant an override
    // written AFTER the first approval was shown to nobody, ever — the
    // banner described a container and a different one ran.
    // 🛑 THE OVERRIDE RESOLVED ABOVE, NOT A SECOND READ OF THE FILE. The value
    // this spawn hands the container is `containerOverride`; a verdict computed
    // from a re-read compares a different snapshot, and a write landing between
    // the two spawns an unapproved value under a `confirmed` verdict.
    const verdict = confirmVerdict(
      opts.handle,
      buildConfirmPlan(opts.vendor, opts.handle, containerOverride),
    );

    if (verdict.kind !== "confirmed") {
      const reconfirm =
        `run \`chat-mcp supervise ${opts.handle} --container\` ` +
        "interactively once to approve it";

      throw new Error(
        verdict.kind === "changed"
          ? `the container plan for "${opts.handle}" changed since it was ` +
              `approved:\n${describeChanges(verdict.changes)}\n${reconfirm}`
          : `container plan for "${opts.handle}" is not confirmed; ${reconfirm}`,
      );
    }
  }

  // 🛑 THROWS BEFORE ANYTHING SPAWNS. A child's cwd is reachable by
  // definition, so an unvalidated one is a containment hole that no
  // allowlist or directory list can close.
  // 🛑 REGISTERED PER HANDLE, AND IT THROWS WHEN NOTHING IS. Two earlier
  // shapes failed: a hardcoded list named one agent's trees and refused the
  // other's, and `process.cwd()` silently pointed the child at whatever
  // terminal the operator happened to be in. The arrangement is already
  // one clone per agent — claude1 in ~/dev/leagues, claude2 in ~/dev/leagues2
  // — so the mapping is explicit. lee, 2026-10-31.
  const dirs = opts.extraDirs ?? dirsFor(opts.handle);

  const { mountsFor, containerPathFor } = await import("./mounts.js");

  let needsMountBanner = isContainerSpawn && !opts.resumeSessionId;

  const mountBannerPrefix = (): string => {
    if (!needsMountBanner) return "";
    needsMountBanner = false;

    // 🛑 ONE PER LINE, KEY QUOTED, for the reason `describePlan` is. A mount
    // key is unvalidated by design, so `", "` inside one made a single entry
    // read as two and told the agent it had a directory it does not.
    //
    // ⚠️ NOT AN EXACT COLLISION, unlike the consent banner's. The entry embeds
    // the key twice around a fixed ` -> `, so no two distinct key sets render
    // identically — measured by exhaustive search over adversarial keys. This
    // misinforms the child; it never corrupted an operator's consent.
    //
    // Rejected: sharing a formatter with `describePlan`. That one quotes a
    // whole path and this one quotes only the left half of an arrow, so the
    // common part is a two-space indent and extracting it helps nobody.
    const entries = Object.entries(mountsFor(opts.handle)).map(
      ([key]) => `  ${JSON.stringify(key)} -> ${containerPathFor(key)}`,
    );

    return entries.length === 0
      ? ""
      : `Mounted directories:\n${entries.join("\n")}\n\n`;
  };

  const childCwd = resolveCwd(opts.cwd, dirs);

  /**
   * The handoff pointer: its OWN prompt, once per fresh session.
   *
   * 🛑 NOT A PREFIX ON AN INBOUND PROMPT, AND `mountBannerPrefix` ABOVE IS THE
   * WRONG PRECEDENT TO COPY. Shipped as a prefix it broke two invariants the
   * gate caught in one assertion:
   *
   *   the `alert` banner stopped being FIRST, so a BLOCKING message opened
   *   with a paragraph about a file — the urgency the banner exists to carry
   *
   *   it displaced the body out of `excerptForLog`'s window, which is the
   *   exact defect `LOG_EXCERPT_LIMIT` was raised from 80 to 200 to fix
   *
   * The mount banner is a few short lines and survives both. This is a
   * paragraph, and a paragraph has to be its own turn.
   *
   * 🛑 GATED ON A FRESH CHILD AND NOT ON THE MODE. A host agent has a project
   * directory and therefore a handoff — copying the mount banner's
   * container-only gate would leave the host arm silent with a green suite.
   *
   * 🛑 THE CALLER DECIDES WHAT FRESH MEANS, AND `opts.resumeSessionId` IS NOT
   * IT. `doRestart` spawns with `resumeSessionId: undefined`, so a supervisor
   * STARTED as a resume still hands its RESTARTED child a clean slate —
   * reading the option here silenced the pointer for exactly the agents most
   * likely to be restarted. `needsMountBanner` drops the same term at the
   * restart, for the same reason.
   *
   * 🛑 `childCwd`, NOT `opts.cwd`. The requested value may be undefined, and
   * `resolveCwd` is what makes it real, contained and realpath'd — so the
   * agent is handed the directory it is actually sitting in.
   */
  const offerHandoffPointer = (freshChild: boolean): void => {
    if (!freshChild) return;

    // 🛑 THE OFFER DISPATCHES SYNCHRONOUSLY ON AN IDLE QUEUE, so a child whose
    // stdin is already gone throws `wiring.ts`'s `stdin.write` straight out of
    // `startSupervisor`. The pointer is a convenience; a supervisor that never
    // starts reports nothing and cannot be asked to stop. Lose the pointer.
    // 🛑 WRITTEN BEFORE THE OFFER, so the sentence below cannot point at a file
    // that was never created. Regenerated every start on purpose: the rules
    // have one source, and a hand-edited copy in a scratch directory is how a
    // sandbox comes to hold the stale wording.
    //
    // 🛑 THE HOST PATH, NOT THE ONE IN THE PROMPT. The container reads
    // `/work/ETIQUETTE.md`; the supervisor writes `<projectDir>/ETIQUETTE.md`
    // and the read-write project bind makes them the same byte.
    //
    // ⚠️ A FAILED WRITE MUST NOT STOP THE SUPERVISOR, for the same reason the
    // offer below must not: the rules are a convenience and a supervisor that
    // never starts reports nothing. `etiquette-write.test.ts` makes this throw
    // and asserts BOTH halves — the log line, and that the start survives.
    try {
      writeFileSync(etiquetteHostPath(childCwd), etiquetteBody(), "utf8");
    } catch (err) {
      log(`FAILED to write the etiquette file: ${String(err)}`);
    }

    // 🛑 ONE OFFER CARRYING BOTH, NEVER TWO. Each offer is its own turn, and
    // PR 469 measured what a spare turn costs: the pointer turn consumed the
    // turn a context-gate restart needed for its own notice, and the suite
    // went red at 33 failures from that one cause.
    try {
      queue.offer({
        text:
          handoffPreamble(handoffPathFor(selection.mode, childCwd)) +
          " " +
          etiquetteSentence(etiquettePathFor(selection.mode, childCwd)),
        messageIds: [],
      });
    } catch (err) {
      log(`FAILED to offer the handoff pointer: ${String(err)}`);
    }
  };
  // Injected in tests; the real one is the shared bus database the web UI
  // already reads.
  const approvalsDb = opts.db ?? openDb();
  const spawnRaw =
    opts.spawnChild ??
    ((o: SpawnOptions) =>
      selection.mode === "docker"
        ? spawnContainerized(opts.vendor, o)
        : spawnOnHost(opts.vendor, o));

  // 🛑 ONE INJECTION POINT FOR EVERY CONSUMER OF THE OVERRIDE. The child is
  // spawned in three places — first start, restart, replace — and the install
  // container is a fourth consumer on its own object. An override added at
  // each site is an override that will be at three of them next time someone
  // adds a fifth, and a restart that dropped it would bring the agent back
  // UNCAPPED with the operator's file still on disk and nothing saying so.
  const withOverride = (o: SpawnOptions): SpawnOptions => ({
    ...o,
    containerOverride,
  });

  // 🛑 WRAPPED ONCE, NOT ASSERTED AT EACH CALL SITE. The child is spawned in
  // three places, and a guard repeated three times is a guard that will be two
  // next time someone adds a fourth.
  const spawnFn = (o: SpawnOptions): AgentChild => {
    const spawned = spawnRaw(withOverride(o));

    try {
      return assertDeclaresCapabilities(spawned);
    } catch (err) {
      // 🛑 THE PROCESS ALREADY EXISTS BY THE TIME WE CAN CHECK IT. The guard
      // reads a property of the returned child, so a real driver that omits a
      // field has already spawned a process or a container when it throws —
      // and nobody holds a reference to it. Raised by claude2 on PR 218.
      try {
        spawned.kill();
      } catch (killErr) {
        // Swallowed on purpose: `err` is the reason the operator needs, and a
        // failing kill must not replace it. Logged so it is not invisible.
        log(
          `could not kill the child of an undeclared driver: ${String(killErr)}`,
        );
      }

      throw err;
    }
  };

  /**
   * 🛑 `initialGrant`, NOT `grant`. It is the set at SPAWN and it never
   * changes, so a reader who wants "what is in force" must not be able to
   * reach it by typing the obvious name. `currentGrant` below is that value.
   *
   * It was called `grant`, and the denial recorder read it while the widening
   * path read `currentGrant`. Every denial after the first then recorded the
   * set the child started with. Renaming makes the compiler find each site,
   * which is the property the four earlier instances of this shape lacked.
   */
  const initialGrant = opts.grant ?? buildGrant(opts, dirs);

  /**
   * 🛑 THE BIND IS THE ONLY ATOMIC CLAIM ON A HANDLE, SO IT RUNS BEFORE THE
   * SPAWN. `refuseIfSupervisorLive` at the top of this function is advisory by
   * construction — `existsSync` plus a liveness probe — so two supervisors can
   * both read "not live" and both go on to spawn. The containerized spawn then
   * runs `docker rm -f` on a name derived from the handle, which SIGKILLs the
   * first supervisor's live agent.
   *
   * Both destructive steps the earlier guard was protecting are still
   * downstream of this line: the per-handle MCP config is written inside the
   * driver, and so is the `docker rm -f`. Every throwing precondition is
   * upstream of it, so a refused start never reaches the bind.
   *
   * ⚠️ THAT COVERS THE PRECONDITIONS ONLY. Below the bind, the window is
   * guarded at the spawn and nowhere else, so a throw between the spawn and
   * the handler install would strand both the listener and the child. Nothing
   * there throws today.
   */
  // 🚨 THE COLD INSTALL RUNS HERE, BEFORE `WakeListener.bind` BELOW, AND THE
  // POSITION IS THE WHOLE POINT. `runDependencyInstall` is synchronous and a
  // first `npm ci` takes minutes, so doing it once the listener is bound would
  // freeze the event loop while senders wait on a socket that cannot answer.
  // lee's ruling of 2026-11-15 is that the supervisor stays up and answers
  // `ok: false`; a frozen loop answers nothing. Nothing is bound yet here, so
  // a caller blocking is honest rather than a lie.
  //
  // ⚠️ THIS IS NOT THE ONLY CALL, ON PURPOSE. `spawnContainerized` calls it on
  // every spawn including a restart, because a lockfile that changed
  // mid-session must not leave the agent on the previous dependency tree. This
  // call is what makes the FIRST start's install the cold one, so the
  // per-spawn call is a warm no-op at around a second — the bar `docker rm -f`
  // is already held to.
  //
  // 🛑 A RESTART AFTER A LOCKFILE CHANGE IS STILL A COLD INSTALL ON A BOUND
  // LOOP. Accepted rather than fixed here. Refusing that restart was the
  // alternative and it is worse: `doRestart` kills the child before it spawns,
  // so a refusal leaves the handle with no agent at all and no remedy short of
  // restarting the supervisor. A pause self-resolves.
  //
  // 🛑 ROUTED THROUGH THE SAME SEAM AS THE SPAWN. `spawnChild` means the caller
  // owns child creation, and a containerized child is not created without its
  // dependencies — so an injected spawn silences this by default rather than
  // leaving a second real side effect for every test to remember.
  const installDeps =
    opts.installDeps ??
    (opts.spawnChild
      ? () => undefined
      : (o: SpawnOptions) => runDependencyInstall(opts.vendor, o));

  if (isContainerSpawn) {
    // 🛑 THROUGH `withOverride`, BECAUSE THE INSTALL CONTAINER CHOOSES THE
    // IMAGE WHOSE `node_modules` THE AGENT THEN LOADS. It is a second consumer
    // of the override on its own call object, which `spawnFn` cannot reach, so
    // an `image` honoured at the spawn alone builds in one image and runs in
    // another.
    //
    // ⚠️ WRAPPED AT THE ARGUMENT, NOT BY RENAMING THIS SEAM. Two source-grep
    // guards in `bind-before-spawn.test.ts` anchor on the name `installDeps` —
    // one on this call site, one on the statement above that must still name
    // `opts.spawnChild`. A second variable satisfies neither.
    installDeps(
      withOverride({
        ...opts,
        cwd: childCwd,
        supervisorHandle: opts.handle,
      }),
    );
  }

  /**
   * 🛑 OPENED BEFORE THE SPAWN, BECAUSE THE CHILD IS CONFIGURED WITH ITS URL.
   * A containerized child reaches the bus over HTTP and nothing else — the
   * state-dir mount that used to carry it is gone, so without this the spawn
   * refuses rather than starting an agent that answers nothing.
   *
   * Host children keep the stdio shim, which needs no socket.
   */
  const hostBus: HostBus | undefined =
    isContainerSpawn && initialGrant
      ? await openHostBus(initialGrant.handle)
      : undefined;

  let onWake: ((envelope: WakeEnvelope) => WakeAck) | null = null;

  const listener = await WakeListener.bind(opts.handle, (envelope): WakeAck => {
    // 🛑 FIRST STATEMENT, ABOVE THE STOP BRANCH, AND THE ORDER IS THE POINT.
    // The real handler closes over eight bindings declared below the spawn.
    // The first it touches is `doStop`, inside a `setImmediate`, where a
    // temporal-dead-zone throw lands outside this call stack and takes the
    // supervisor down instead of refusing a wake. lee ruled on 2026-11-11 that
    // a wake arriving here is refused rather than queued.
    if (onWake === null)
      return { ok: false, error: "supervisor is still starting" };

    return onWake(envelope);
  });

  /**
   * The live child. Mutable, because replacing it is a first-class operation.
   *
   * 🛑 IT USED TO BE `const` AND SPAWNED EXACTLY ONCE, which is how the
   * approval path stayed broken after it looked fixed: a grant recorded the
   * command, sent the child a prompt saying it was now allowed, and never
   * changed the child's `--allowedTools`. The next attempt was denied again.
   * `grantedCommands` was written and never read.
   */
  let child: AgentChild;

  try {
    child = spawnFn({
      ...opts,
      cwd: childCwd,
      grant: initialGrant,
      supervisorHandle: opts.handle,
      bus: hostBus?.endpoint,
    });
  } catch (err) {
    // The listener was holding the handle for a start that is not happening.
    // Leaving it bound would make one failed start a permanent one.
    //
    // 🛑 THE CLOSE MUST NOT REPLACE THE SPAWN'S ERROR. A rejecting `close()`
    // would skip the throw below and show the operator a teardown failure
    // instead of the reason their agent never started.
    try {
      await listener.close();
    } catch {
      // Swallowed on purpose; `err` is the one worth reporting.
    }

    try {
      await hostBus?.close();
    } catch {
      // Same reason: the spawn's error is the one the operator needs.
    }

    throw err;
  }
  let currentGrant = initialGrant;
  let currentModel = opts.model;

  /**
   * The handle the CHILD holds on the bus, which is never `opts.handle`.
   *
   * 🛑 READ IT, DO NOT CACHE IT. `currentGrant` is reassigned on a replace, so
   * a value captured at wiring time names the previous grant's handle.
   */
  const childBusHandle = () =>
    currentGrant?.handle ?? childHandleFor(opts.handle);

  /**
   * Whether the child holds the one tool the DM clause names.
   *
   * 🛑 READ IT, DO NOT CACHE IT, for `childBusHandle`'s reason. A server-wide
   * `mcp__chat` counts, because it grants every tool under that server — an
   * exact-match-only test would read such a grant as no-send.
   */
  const childCanSend = () =>
    !!currentGrant &&
    currentGrant.allowed.some(
      (t) => t === "mcp__chat__send" || t === "mcp__chat",
    );

  /**
   * Publishes `childCanSend()` on the child's row, so a SENDER can refuse a
   * DM that would never be answered (#475).
   *
   * 🛑 IT RETRIES, BECAUSE THE ROW IS NOT THERE YET. The shim writes it when
   * the child registers, which is after this. `can-reply.ts` carries the full
   * reason; the short version is that an unretried write publishes nothing.
   */
  const canReply = createCanReplyPublisher({
    write: (value) =>
      dao.setAgentCanReply(approvalsDb, childBusHandle(), value),
    canSend: childCanSend,
    retryMs: opts.canReplyRetryMs ?? 1000,
    onError: (e) =>
      log(
        `FAILED to publish ${childBusHandle()}'s reply capability: ${
          e instanceof Error ? e.message : String(e)
        }; a DM to it may be refused until something rewrites the row`,
      ),
  });
  canReply.publish();

  // 🛑 SAID OUT LOUD, both ways. A doorbell that cannot answer and a child
  // holding a bus identity are both things an operator must be able to see in
  // the log rather than deduce from a flag they did not pass.
  log(
    initialGrant
      ? `child acts as "${initialGrant.handle}"; ${initialGrant.allowed.length} allowed tool(s), ` +
          `built-ins: ${initialGrant.available.join(" ")}`
      : "child has NO grant — it can be woken and can do nothing (--no-reply)",
  );
  const gate = new RateLimitGate(
    opts.utilizationCeiling ?? 0.9,
    child.reportsUsage,
  );

  /**
   * Accepted but not dispatched, because the window was too full.
   *
   * 🛑 HELD, NOT DROPPED. Refusing to spend a turn must not lose the message —
   * that would trade a cost problem for a correctness one. These are released
   * the moment a rate-limit event says there is room.
   */
  const held: { text: string; messageIds: number[]; owedTo?: string }[] = [];

  /**
   * Who to tell if this turn answers nobody, or `null`.
   *
   * 🛑 A SEPARATE BINDING FROM `turn`, BECAUSE `newTurn` TAKES A BOOLEAN. The
   * detector decides WHETHER a reply was lost and must not also know who was
   * asking — that is this file's wiring. Reassigned in lockstep with `turn`
   * so the two can never describe different turns.
   */
  let owedTo: string | null = null;

  /** Observers of the child finishing a turn. See `Supervisor.onTurnEnd`. */
  const turnEndListeners: (() => void)[] = [];

  /** Observers of this supervisor having stopped. See `Supervisor.onStopped`. */
  const stoppedListeners: (() => void)[] = [];

  /**
   * Observers of a prompt actually being WRITTEN to the child — distinct
   * from `queue.offer()` being CALLED, which merely queues it when a turn is
   * already in flight. A graceful restart must know when its notice was
   * truly dispatched, not when it was merely offered: offering it just
   * marks it pending, and the turn-end that later flushes it into dispatch
   * is itself an observer-notified event, so "offered" and "sent" can be
   * ticks apart.
   */
  const sendListeners: ((prompt: {
    text: string;
    messageIds: readonly number[];
  }) => void)[] = [];

  /**
   * Counts each onTurnEnd invocation, incremented BEFORE `queue.turnEnded()`
   * runs. A prompt dispatched from inside one turn-end call (because it was
   * queued behind an in-flight turn) and the turn-end that completes that
   * SAME prompt's own turn are two different calls one count apart — this
   * is how a graceful restart tells them apart. See `restartChild`.
   */
  let turnEndCount = 0;

  /**
   * What the CURRENT turn has produced, for #224's lost-reply check.
   *
   * 🛑 `false` UNTIL A PROMPT IS DISPATCHED. A turn nobody asked for owes
   * nobody an answer, so the initial value must not warn.
   */
  let turn = newTurn(false);

  const queue = new TurnQueue({
    send: (prompt) => {
      log(`→ child: ${excerptForLog(prompt.text)}`);
      // An inbound bus message carries its id; every internal prompt offers
      // `messageIds: []`. That list IS "is a peer waiting for this".
      turn = newTurn(prompt.messageIds.length > 0);
      owedTo = prompt.owedTo ?? null;
      child.send(prompt.text);
      for (const cb of sendListeners) cb(prompt);
    },
  });

  const releaseHeld = (): void => {
    if (held.length === 0 || !gate.verdict().allow) return;

    log(`window has room again; releasing ${held.length} held message(s)`);

    for (const h of held.splice(0, held.length)) queue.offer(h);
  };

  /**
   * 🛑 THE PRODUCER. Without it `denialFromClaude` was imported and never
   * called and `insertApproval` had no caller in `src/` at all — the approval
   * path began one step AFTER the break, which is why a live test that
   * inserted the row by hand passed against a feature that did not exist.
   * Found by claude1 reviewing PR 34.
   *
   * A denial is not a delay. The child is instructed not to retry for the
   * rest of its session, so an unrecorded denial is an agent that has given
   * up silently.
   */
  /**
   * Commands the operator has granted this supervisor, cumulative.
   *
   * ⚠️ ADDITIVE. A grant that replaced the list would revoke everything the
   * agent already had, mid-task, and the symptom would be a second denial for
   * something that worked a minute earlier.
   */
  const grantedCommands: string[] = [];

  /**
   * Which spawn is current. A dead child's callbacks must not act on the
   * live one's state.
   */
  let childGeneration = 0;

  /**
   * Whether `doStop` has begun. Read by `onExit`, which is why it is declared
   * HERE rather than beside `doStop`.
   *
   * 🛑 A STOP KILLS THE CHILD WITHOUT MOVING THE GENERATION, so the exit of a
   * stopping supervisor's child is CURRENT and its handler runs. `doStop`
   * closes the socket itself, after the teardown, and `onExit` must not beat
   * it to it — see the socket close there.
   */
  let hasStopped = false;

  /**
   * Tear down everything a gone child leaves behind, then report stopped.
   *
   * 🛑 DECLARED HERE BECAUSE `onExit` CALLS IT TOO, and `wireChild` runs long
   * before `doStop` is defined. A child can exit during startup.
   *
   * ⚠️ NOT `doStop("now")` FROM `onExit`. `doStop` kills the child and awaits
   * its teardown, and on the own-exit path the child is already gone — for the
   * containerized driver that `kill()` spawns `docker stop` against a
   * container that no longer exists.
   */
  const finishShutdown = async (): Promise<void> => {
    // 🛑 THE SOCKET GOES LAST, SO ITS DISAPPEARANCE MEANS THE CHILD IS REALLY
    // GONE. What makes that true differs per caller: `doStop` awaits the
    // child's teardown before calling this, and the own-exit path is called BY
    // the exit. Envelopes arriving in this window are refused above, not
    // delivered to a dead child.
    // 🛑 BEFORE THE SOCKET GOES, so the window where the row still claims an
    // answer is as short as it can be. `clear` writes NULL, not 0 — nobody is
    // publishing now, and a sender must go ahead rather than be refused by
    // debris.
    canReply.clear();

    await listener.close();
    await hostBus?.close();

    // Registration happens in the CHILD, via the shim. So this deletes a row
    // this process did not write, which is why it is opt-in and not default.
    if (opts.ephemeral === true) dao.deleteAgent(approvalsDb, opts.handle);

    for (const cb of stoppedListeners) cb();
  };

  /**
   * Whether a replace or a restart is between the kill and the respawn.
   *
   * 🛑 `ifCurrent` ASSUMES THE EXIT IS ASYNC, and the generation only moves
   * inside `wireChild` or on a throw. An exit delivered synchronously from
   * `kill()` is therefore still CURRENT, so the socket close needs this too.
   * Cleared only where the generation has already moved.
   */
  let replacingChild = false;

  /**
   * Tells the web UI this agent is working, #240.
   *
   * 🛑 ONE PER SUPERVISOR, AND IT TAKES `childBusHandle` ITSELF. A reporter per
   * child would reset the throttle on every replacement, and a captured handle
   * would go stale against the rule on `childBusHandle` above. The pulse lands
   * on the CHILD row because that is the one `list_agents` shows — the same
   * finding `context-gauge.test.ts` records for the gauge.
   */
  const reportActivity = createActivityReporter({ handle: childBusHandle });

  let childSession: string | null = null;

  /**
   * Model ids already reported as having no known window, and whether the
   * unregistered-child notice has been said.
   *
   * ⚠️ ONCE EACH, BECAUSE THE GAUGE FIRES EVERY TURN. An unconditional log
   * would put the same line in front of the operator hundreds of times and
   * train them to skip it, which is how a real warning stops being read.
   */
  const warnedFallbackWindows = new Set<string>();

  /**
   * ⚠️ RESET PER CHILD, INSIDE `wireChild`. A process-lifetime latch went
   * silent when a REPLACEMENT child was also unregistered, so the operator
   * kept reading the previous child's last fill as if it were live. Raised by
   * the dry-solid reviewer.
   */
  let warnedUnregisteredGauge = false;

  /**
   * Run the graceful restart, set once `restartChild` exists.
   *
   * 🛑 AN INDIRECTION BECAUSE `wireChild` RUNS LONG BEFORE `restartChild` IS
   * DECLARED. Naming the const directly from a callback registered at line
   * ~1040 reads fine and is a `ReferenceError` if any driver ever delivers a
   * reading synchronously from `onContext` registration — and the gauge
   * handler's own try/catch would log that as "FAILED to record the context
   * gauge" and swallow the restart. Nothing else inside `wireChild` reaches
   * forward like that, so this does not start the habit either.
   *
   * ⚠️ A READING BEFORE IT IS SET IS A NO-OP, WHICH IS CORRECT RATHER THAN
   * CONVENIENT. That window closes during `startSupervisor`, when the child's
   * fill is still at its spawn floor and no gate can legitimately be reached.
   */
  let runGracefulRestart: (() => void) | null = null;

  /**
   * Whether this child has already been told to restart on its gate.
   *
   * ⚠️ RESET PER CHILD, INSIDE `wireChild`, for the opposite reason to
   * `warnedUnregisteredGauge`'s. A process-lifetime latch would restart the
   * FIRST child and then let every replacement fill to 100% unattended, which
   * is the failure #135 exists to end. The replacement's window starts over,
   * so its gate is a fresh event.
   */
  let gateRestartRequested = false;

  /**
   * This child's first reading, which is as close to its spawn fill as the
   * driver reports. `null` until one arrives.
   *
   * 🛑 A GATE AT OR BELOW IT IS AN INFINITE RESTART LOOP, AND EVERY GATE FROM
   * 1 TO 100 IS LEGAL CONFIG. A fresh container child sat at 14.4% of its
   * window before doing any work — its system prompt plus its tool definitions
   * — so a gate of 10 is reached by the FIRST reading, and the replacement's
   * first reading is the same number. The restart reclaims nothing and the next
   * reading asks for another. Found by claude2 reviewing this before it merged.
   *
   * ⚠️ IT IS THE LOWEST READING SEEN, NOT THE FIRST ONE. A first reading
   * can be wrong: `cursor1-agent` reported 57.4% while its window actually
   * held 23.9%, which latched a floor above the gate and left the child with
   * no restart for the rest of its life. The minimum only ever falls, so a
   * child whose fill genuinely never drops below its gate still never
   * restarts — which is the loop guard above, intact.
   */
  let childFloor: number | null = null;

  /** Once per child: see `childFloor`, and `warnedFallbackWindows` for why. */
  let warnedGateUnderFloor = false;

  /**
   * Once per child, and only after `warnedGateUnderFloor`.
   *
   * 🛑 THE WARNING SAYS "NOTHING WILL RESTART THIS CHILD", WHICH A LOWER
   * READING MAKES FALSE. An operator acts on that sentence — raising the gate
   * is what it asks for — so leaving it standing is worse than never having
   * logged it.
   */
  let withdrewGateUnderFloor = false;

  /**
   * Restart the child if this reading has reached the handle's gate.
   *
   * 🛑 THE GATE IS RESOLVED PER READING, NOT CACHED AT SPAWN. An operator who
   * raises a handle's gate mid-run expects the next reading to honour it, and
   * `resolveContextGate` is documented as cheap enough for this path.
   *
   * 🛑 ONE NOTICE PER CHILD. `restartChild('graceful')` queues the externalize
   * notice and waits for the turn after it; a second call inside that window
   * queues a second notice and starts a second wait, so the child is told
   * twice and the first wait still fires.
   *
   * 🛑 IT TAKES THE READING, NOT A PERCENT, SO THE WINDOW RULE LIVES WITH THE
   * FLOOR RULE. `childFloor` is the thing that breaks on a percent derived
   * from no window, and a `0` is a legal-looking argument — so a guard at the
   * call site is a rule a second caller can omit silently. claude2 raised this
   * as the invariant sitting away from the code that depends on it, and the
   * ramp in 3b is that second caller.
   */
  const checkContextGate = (
    childHandle: string,
    used: number,
    total: number,
  ): void => {
    if (gateRestartRequested) return;

    // 🛑 A READING WITH NO WINDOW IS SKIPPED, NOT TREATED AS 0%.
    // `contextPercent` answers 0 for a total of 0, and latching that as the
    // spawn floor turns the loop guard OFF for this child's whole life: every
    // later reading then looks like a legitimate climb from empty, and a gate
    // under the real spawn fill restarts forever.
    //
    // ⚠️ SKIPPED, NOT FATAL. A driver that emits one such reading must not
    // lose the gate for every child behind it, which is what latching any
    // floor here would cost. Unreachable on the claude driver, whose fallback
    // window is 200000, and reachable at the `ContextSnapshot` vendor seam.
    // Measured by claude2 on PR 311.
    if (!Number.isFinite(total) || total <= 0) return;

    const percent = contextPercent(used, total);
    const gate = resolveContextGate(approvalsDb, childHandle);

    // 🛑 THE MINIMUM, NOT THE FIRST READING. See the declaration: a wrong
    // first reading otherwise disables this child's gate permanently.
    childFloor = childFloor === null ? percent : Math.min(childFloor, percent);

    // 🛑 REFUSED FOR THIS CHILD'S WHOLE LIFETIME, not just for the reading
    // that showed it. Skipping one reading halves the loop's rate and does not
    // end it. See `childFloor`.
    if (childFloor >= gate) {
      if (!warnedGateUnderFloor) {
        warnedGateUnderFloor = true;
        log(
          `restart gate of ${gate}% is at or below ${childHandle}'s spawn fill of ${childFloor.toFixed(1)}%; ` +
            `a restart cannot reclaim that, so NOTHING will restart this child — raise the gate`,
        );
      }

      return;
    }

    // 🛑 WITHDRAWN THE MOMENT IT STOPS BEING TRUE, not at the next restart.
    // Reaching here means the floor is now under the gate, so the sentence the
    // operator read above no longer holds.
    if (warnedGateUnderFloor && !withdrewGateUnderFloor) {
      withdrewGateUnderFloor = true;
      log(
        `${childHandle} now reads a floor of ${childFloor.toFixed(1)}%, under its restart gate of ${gate}% — ` +
          `the earlier warning is withdrawn and the gate is reachable again`,
      );
    }

    if (percent < gate) return;

    gateRestartRequested = true;

    log(
      `${childHandle} at ${percent.toFixed(1)}% context reached its restart gate of ${gate}%; ` +
        `sending the externalize notice, then restarting`,
    );

    runGracefulRestart?.();
  };

  /**
   * Register every callback on the CURRENT child.
   *
   * 🛑 CALLED AGAIN AFTER A REPLACEMENT. Callbacks live on the instance, so a
   * new child with none of them would leave the queue waiting forever for a
   * turn that already ended, and the supervisor would look hung.
   */
  function wireChild(): void {
    // 🛑 SEMANTIC CALLBACKS ONLY. Nothing here knows any CLI's event shapes.
    //
    // 🚨 `onTurnEnd` WAS REGISTERED OUTSIDE THIS FUNCTION, ON THE FIRST CHILD
    // ONLY. Every replacement then hung: the new child's turn-complete signal
    // reached nothing, the queue stayed `inTurn` forever, and the supervisor
    // looked idle rather than broken. The approval path is the only caller,
    // so it was the FIRST approval, not an edge case. Found by claude1.
    const generation = ++childGeneration;

    // See the declaration: this notice is once per child, not once per process.
    warnedUnregisteredGauge = false;

    // See the declaration: the replacement's window starts over, so its gate
    // is a fresh event rather than one already spent, and its spawn fill is
    // its own to measure.
    gateRestartRequested = false;
    childFloor = null;
    warnedGateUnderFloor = false;
    withdrewGateUnderFloor = false;

    /**
     * 🛑 EVERY CALLBACK GOES THROUGH THIS, NOT JUST THE ONE THAT BIT.
     *
     * A replaced child keeps emitting, and its callbacks close over the
     * MUTABLE `child` binding — so a stale signal acts on the LIVE child. The
     * first version guarded `onExit` alone, which claude1 pointed out is one
     * of four.
     *
     *   onTurnEnd  a stale turn-end releases the queue into a child that is
     *              mid-turn, so two turns run at once
     *   onDenial   the dying child was just denied X, so one more denial for
     *              X files a SECOND approval for the command lee just granted
     *   onUsage    benign, wrapped for uniformity — an unwrapped one is the
     *              exception a reader has to re-derive
     *   onContext  a dying child's last turn would overwrite the LIVE child's
     *              gauge, so the operator reads the dead session's fill
     *
     * ⚠️ `onTurnEnd` had `generation` in scope two lines above and did not
     * use it. A per-call check is something to forget; a wrapper is not.
     */
    const ifCurrent = <A extends unknown[]>(
      label: string,
      fn: (...args: A) => void,
    ) => {
      return (...args: A): void => {
        if (generation !== childGeneration) {
          // 🛑 SAY IT, DO NOT SWALLOW IT. The first version returned
          // silently, which is the ambiguity this file argues against two
          // lines later. A dropped signal and a signal that never came look
          // identical otherwise. Raised by claude1.
          log(`stale ${label} from replaced child #${generation}; ignoring`);

          return;
        }

        fn(...args);
      };
    };

    /**
     * 🛑 THE ONLY WINDOW ONTO WHAT THE AGENT ACTUALLY DID. Without it a
     * child that ran a turn and answered nothing logs exactly what a child
     * that answered perfectly logs, and the difference is only visible in
     * the database afterwards.
     */
    // 🛑 GUARDED, FOR THE SAME REASON `onEvent` IS. A first cut left this
    // unwrapped, arguing a replaced child's dying words are the most useful
    // stderr there is. They are — but a stale child keeps emitting, and an
    // unguarded line is logged as the LIVE child's, which is the ambiguity
    // this logging exists to remove. A `← child stderr:` prefix does not
    // separate the old child from the new one. `ifCurrent` SAYS it dropped a
    // stale line, so the loss is visible rather than silent.
    child.onStderr(
      ifCurrent("onStderr", (line: string) => {
        // `wiring.ts` already drops blank lines. Repeated here because a driver
        // may deliver this callback by another route, and a log spammed one
        // entry per empty flush is unreadable either way.
        if (line.trim().length === 0) return;

        log(`← child stderr: ${line}`);
      }),
    );

    child.onEvent(
      ifCurrent("onEvent", (event) => {
        // 🛑 NOT AWAITED, AND INSIDE `ifCurrent`. This runs while draining the
        // child's stdout, and a dead child must not pulse a live dot.
        reportActivity("tick");

        const said = describeChildOutput(event);

        if (said) log(`← child: ${said}`);

        const outcome = describeTurnResult(event);

        if (outcome) log(`← result: ${outcome}`);

        observe(turn, event);
      }),
    );

    child.onToolCall(
      ifCurrent("onToolCall", (name, why) => {
        // 🛑 A CALL THE DRIVER COULD NOT NAME IS LOUD, NOT DROPPED. Cursor's
        // event shape is read out of its shipped bundle rather than off a
        // captured stream, so a wrong field path is possible — and its
        // failure mode is the exact silence #392 exists to end. A line here
        // turns that into something an operator can report.
        //
        // 🛑 IT USED TO `return` HERE, SO THE NULL NEVER REACHED THE FOLD.
        // `observeToolCall`'s own null branch was unreachable, and the unit
        // test that covered it could not have said no. #417.
        if (name === null) {
          log(
            `⚠️ the agent called a tool and this driver could not read its ` +
              `name (${why ?? "no reason given"}), so a send through it would ` +
              `not clear the silent-reply warning`,
          );
        }

        observeToolCall(turn, name, why);
      }),
    );

    /**
     * Put the lost-reply verdict in front of the peer who is waiting for it.
     *
     * 🛑 `SYSTEM_HANDLE` IS THE SENDER, NEVER THE AGENT'S HANDLE. Sending as the
     * agent puts words in its mouth, and a DM from a handle the supervisor is
     * driving can re-enter its own wake path — one lost reply becoming a loop.
     *
     * 🛑 THE VERDICT TEXT IS `silentReplyWarning`'s, NOT A SECOND COPY. Its two
     * branches are the whole discrimination between a reply that reached nobody
     * and one whose delivery is UNKNOWN, and a paraphrase here is where that
     * distinction drifts into an accusation. #417.
     *
     * ⚠️ IT MUST NOT THROW INTO THE TURN. A send that cannot land is worth a log
     * line and nothing more — the turn itself completed.
     */
    function tellSenderNobodyAnswered(peer: string, verdict: string): void {
      const body = `⚠️ ${childBusHandle()} answered your message inside its own transcript only — ${verdict}.`;

      try {
        const result = dao.insertMessage(approvalsDb, {
          from: dao.SYSTEM_HANDLE,
          to: peer,
          body,
          kind: "chat",
        });

        notifyPeer(peer, {
          id: result.id,
          to: peer,
          from: dao.SYSTEM_HANDLE,
          ts: result.sent_at,
          body,
          kind: "chat",
        });
      } catch (e) {
        log(
          `⚠️ lost-reply notice undelivered to ${peer}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    child.onTurnEnd(
      ifCurrent("onTurnEnd", () => {
        turnEndCount++;

        // 🛑 BEFORE `queue.turnEnded()`, WHICH CAN DISPATCH THE NEXT PROMPT
        // SYNCHRONOUSLY AND REPLACE `turn`. Measured: with a second message
        // queued, `→ child:` for it is logged before `← turn complete`.
        const lost = silentReplyWarning(turn);

        if (lost) log(`⚠️ ${lost}`);

        // 🛑 THE LOG LINE WAS THE ONLY OUTPUT AND THE PERSON WAITING READS
        // CHAT. The detector got lee's cursor1 turn right on the first try and
        // he still had to diagnose it by hand. #472.
        if (lost && owedTo) tellSenderNobodyAnswered(owedTo, lost);

        owedTo = null;

        turn = newTurn(false);

        // 🛑 CLEARS THE PULSE, AND IT IS NEVER THROTTLED. A dropped `end`
        // leaves the dot running to the 30s failsafe, which reads as an agent
        // that never finished.
        reportActivity("end");
        queue.turnEnded();
        log(`← turn complete; ${queue.depth} queued, ${held.length} held`);

        // ⚠️ AFTER the queue is settled, so an observer that reacts by
        // reading state does not see a half-drained queue.
        for (const cb of turnEndListeners) cb();
      }),
    );

    child.onSession(
      ifCurrent("onSession", (id) => {
        childSession = id;
      }),
    );

    /**
     * 🛑 THE GAUGE IS THE CHILD'S, NOT THE SUPERVISOR'S. Verified on the live
     * bus: `list_agents` carried the blank on `claude2-agent`, and `claude2`
     * was not listed at all. Writing it to `opts.handle` would fill a row
     * nobody reads and leave the blank exactly where #213 found it.
     */
    child.onContext(
      ifCurrent("onContext", (snapshot: ContextSnapshot) => {
        // 🛑 THE WHOLE BODY IS GUARDED, NOT JUST THE WRITE. The gauge touches
        // the database three times — the existence read, the row write, and a
        // notify per room member — and the driver's line parser swallows a
        // throw as if it were a non-JSON line, which would silently cost the
        // tool-call recorder a later denial depends on. `onDenial` below
        // already had this shape; this one did not until the dry-solid
        // reviewer said so, and a first cut guarded only the write — the test
        // caught the read escaping.
        try {
          const childHandle = childBusHandle();

          // Clamp rather than refuse: a real window larger than the mapped one
          // means the map is stale, and a gauge pinned at 100% still says full.
          const used = Math.min(snapshot.used, snapshot.total);

          // 🛑 BEFORE THE REGISTRATION GUARD, BECAUSE THE READING IS REAL
          // EITHER WAY. The guard below exists because a row UPDATE against a
          // missing row is silent — a restart is not a row update. A child
          // that fills its window without ever registering on the bus is the
          // case most in need of the restart, and `resolveContextGate` is
          // documented to answer for a handle with no `agents` row.
          //
          // 🛑 ITS OWN CATCH, AND THE OUTER ONE IS WHY. Running first means a
          // throw here would otherwise take the gauge write with it, which
          // nothing before this could do — and it would be logged as "FAILED
          // to record the context gauge", naming the half that still worked.
          // Raised by claude2, who went looking for the catch that swallowed a
          // mutant's `ReferenceError`.
          try {
            checkContextGate(childHandle, used, snapshot.total);
          } catch (err) {
            log(
              `FAILED to check ${childHandle}'s restart gate: ${String(err)}; ` +
                `the gauge reading below is unaffected, but NOTHING restarted this child`,
            );
          }

          // 🛑 AN UPDATE AGAINST A MISSING ROW IS A SILENT NO-OP, which is the
          // exact failure class this ticket exists to end. The row is written
          // by the SHIM when the child registers, so a reading can arrive
          // first.
          if (!dao.getAgent(approvalsDb, childHandle)) {
            if (!warnedUnregisteredGauge) {
              warnedUnregisteredGauge = true;
              log(
                `context gauge: ${childHandle} has not registered on the bus yet; not reporting`,
              );
            }

            return;
          }

          if (
            snapshot.totalIsFallback &&
            !warnedFallbackWindows.has(snapshot.model ?? "")
          ) {
            warnedFallbackWindows.add(snapshot.model ?? "");
            log(
              `context gauge: no window size known for model "${snapshot.model ?? "unreported"}"; ` +
                `using ${snapshot.total} — the percentage is only as right as that guess`,
            );
          }

          applyContextReport(approvalsDb, childHandle, used, snapshot.total);
        } catch (err) {
          log(`FAILED to record the context gauge: ${String(err)}`);
        }
      }),
    );

    child.onDenial(
      ifCurrent("onDenial", (denial) => {
        const grantHandle = childBusHandle();

        try {
          const approvalId = dao.insertApproval(approvalsDb, {
            agentHandle: grantHandle,
            supervisorHandle: opts.handle,
            // 🛑 NULL WHEN THE CLI DID NOT NAME IT, never a placeholder.
            //
            // Measured end to end: a `git push` denial gives a prose reason
            // with no command. A placeholder was filed, lee APPROVED A BLANK,
            // the literal went into `--allowedTools` and granted nothing, the
            // retry was denied, and a second card appeared.
            //
            // ⚠️ FILING NOTHING WAS THE FIRST FIX AND IT WAS WORSE. claude1:
            // it restores the bug #39 exists to fix — the child stops and
            // nobody is told. Worse still, the one unnameable case measured is
            // `git push`, which is on lee's excluded list BY NAME, so silence
            // would land exactly on the high-stakes requests.
            //
            // The row is filed, the reason is shown, and `answerApproval`
            // refuses to APPROVE it. Deny always works.
            requested: denial.requested,
            // 🛑 WHAT THE CARD SHOWS AND WHAT THE GRANT CARRIES ARE DIFFERENT
            // LANGUAGES. `requested` is prose a human reads; `grant` is the
            // allowlist entry. Feeding the prose into `--allowedTools` grants
            // nothing — measured live: lee approved
            // `rm in '/path/README.md'`, the child was denied again, and a
            // second card appeared.
            grant: grantFor(denial),
            // 🛑 EVERY SPELLING OF THE SAME FILE. `/var` and `/private/var`
            // are the same path on macOS, and a grant in one spelling does
            // not match a retry in the other — measured live, caused by this
            // supervisor's own realpath resolution.
            grantForms: grantVariants(denial),
            // 🛑 WHAT WAS IN FORCE WHEN IT WAS REFUSED — SO IT MUST BE THE LIVE
            // VALUE. Without this a refusal cannot say what a grant would have
            // done: the same command is refused under one allowlist and
            // permitted under another, which approvals 23 and 25 measured.
            // Raised by claude1 on PR 43.
            //
            // 🛑 IT READ THE SPAWN-TIME BINDING FOR FOUR COMMITS. Every denial
            // after the first then reported the set the child started with, so
            // the column answered wrongly in exactly the case it was added for.
            // Measured on the live run of 2026-10-31: approvals 50, 52 and 53
            // were all retries and all three recorded the base set. #49.
            allowlist: currentGrant?.allowed ?? [],
            // The CLI's own words, kept verbatim so the denial can be re-parsed
            // if the detector changes.
            reason: denial.raw,
            sessionId: childSession,
          });

          log(
            denial.requested
              ? `child BLOCKED, approval ${approvalId} pending: ${denial.requested}`
              : `child BLOCKED, approval ${approvalId} pending but UNNAMED — it can only be denied`,
          );
        } catch (err) {
          // 🛑 SAY SO. A failed write here means the operator is never asked, and
          // silence is the failure mode this whole path exists to remove.
          log(
            `FAILED to record a denial — nobody will be asked: ${String(err)}`,
          );
        }
      }),
    );

    child.onUsage(
      ifCurrent("onUsage", (snapshot) => {
        gate.update(snapshot);
        log(gate.describe());
        releaseHeld();
      }),
    );

    child.onExit(
      ifCurrent("onExit", (code, signal) => {
        // 🛑 Anything queued is UNSENT. Reporting it is the difference between a
        // visible gap and silence, and silence is the ambiguity this whole change
        // exists to remove.
        // 🛑 CLEARS THE DOT. `onTurnEnd` does not fire for a child that dies
        // mid-turn, so without this the 30s failsafe is the only thing that
        // ends the pulse — and for those 30 seconds a working agent and a dead
        // one look identical, which is the ambiguity #240 exists to remove.
        reportActivity("end");

        const unsent = queue.drain();
        log(
          `child exited code=${code} signal=${signal}; ${unsent.length} prompt(s) never sent`,
        );

        for (const p of unsent) log(`  UNSENT ids=[${p.messageIds.join(",")}]`);

        // 🛑 THE BUS LEARNS THE CHILD IS GONE HERE, OR IT NEVER DOES. A
        // containerized child's row carries the SUPERVISOR's pid, because the
        // host bus registers on its behalf — so `online` stayed true and a
        // sibling handed a review to nothing.
        //
        // ⚠️ Nulling the pid, never deleting the row: the handle must remain
        // visible as offline. Guarded because a child can die before its shim
        // ever registered, and a throw here would lose the report above.
        try {
          if (!dao.clearAgentPid(approvalsDb, childBusHandle())) {
            log(`child ${childBusHandle()} had no bus row to take offline`);
          }
        } catch (err) {
          log(
            `FAILED to take ${childBusHandle()} offline on the bus: ${String(err)}`,
          );
        }

        // 🛑 THE SOCKET GOES WITH THE CHILD, per lee's ruling of 2026-11-14.
        // `onWake` refuses a STARTING and a STOPPING supervisor and nothing
        // else, so an own-exit tripped neither guard: the drain above leaves
        // the queue idle, the next `offer` takes the idle branch, and the
        // sender is acked `sent` for a process that is gone. Closed, the
        // delivery returns `null`, which every caller already reads as "no
        // supervisor".
        //
        // 🛑 TWO EXITS ARE NOT A DEATH, AND NEITHER IS EXCLUDED BY `ifCurrent`
        // ALONE. `replacingChild` covers a replace or a restart, whose kill
        // may deliver the exit synchronously and therefore CURRENT.
        // `hasStopped` covers a stop, which kills the child without moving
        // the generation at all — and `doStop` closes this itself after the
        // teardown, so the socket's disappearance keeps meaning "fully
        // stopped" rather than moving earlier.
        if (!hasStopped && !replacingChild) {
          // 🛑 SET BEFORE THE TEARDOWN, NOT AFTER. The SIGINT handler in
          // `src/index.ts` can still reach `doStop` while this runs, and the
          // early return on this flag is what stops a second teardown and a
          // second `onStopped` — which is wired to `process.exit(0)`.
          hasStopped = true;

          // 🛑 THE EVENT GOES FIRST, AND THE ORDER IS THE RULING. lee,
          // 2026-11-16: *"yes, i like the idea of a exist event"*, on top of
          // shutting the supervisor down. `finishShutdown` fires `onStopped`,
          // which `src/index.ts` wires to `process.exit(0)` — so an
          // announcement after it is an announcement that never happens.
          //
          // ⚠️ GUARDED FOR THE REASON `clearAgentPid` ABOVE IS. A throw here
          // must not cost the shutdown; an unreachable supervisor is worse
          // than an unannounced death.
          try {
            const told = announceChildExit(approvalsDb, {
              supervisorHandle: opts.handle,
              childHandle: childBusHandle(),
              code,
              signal,
            });

            log(
              told.length > 0
                ? `announced the exit in ${told.join(" ")}`
                : `nobody to announce the exit to: neither ${opts.handle} nor ${childBusHandle()} is in a room`,
            );
          } catch (err) {
            log(`FAILED to announce the child's exit: ${String(err)}`);
          }

          // 🛑 THE SUPERVISOR EXITS WITH ITS CHILD, per lee's ruling of
          // 2026-11-16. The close below takes away the ONLY way to reach this
          // process: `stop` and `restart` arrive solely as `envelope.control`
          // over this listener. Staying up left a supervisor with no child, no
          // socket and nothing it could be asked, endable only by `kill <pid>`.
          //
          // ⚠️ `onStopped` IS THE EXIT. `src/index.ts` wires it to
          // `process.exit(0)`, so `finishShutdown` firing it is what ends this
          // process.
          void finishShutdown().catch((err: unknown) => {
            log(`FAILED to shut down after the child exited: ${String(err)}`);
          });
        }
      }),
    );
  }

  wireChild();
  offerHandoffPointer(!opts.resumeSessionId);

  /**
   * Take the outgoing child offline on the bus and stop its activity dot.
   *
   * 🛑 HERE, NOT IN `onExit`. `kill()` returns immediately — a containerized
   * child spawns `docker stop` detached — so the exit lands after the
   * generation has moved and `ifCurrent` drops it as stale. The handler would
   * never run, and `online` stayed true for a child that no longer existed,
   * forever if the respawn then failed. The dot pulsed on for the same reason.
   *
   * ⚠️ Moving the `onExit` clear outside `ifCurrent` is NOT the alternative:
   * that clears a LIVE child's pid on every stale signal. The replacement
   * re-registers its own pid moments later, so a brief offline window here is
   * the honest reading.
   *
   * ⚠️ CALL IT BEFORE `spawnFn`, deliberately. A spawn that throws then leaves
   * `pid = NULL` and the dot cleared, rather than advertising a child that
   * never started.
   *
   * 🛑 `doRestart` HAD NEITHER STEP AND RELIED ENTIRELY ON `onExit`. Bumping
   * the generation on its throw path suppressed that exit, so a failed restart
   * left a dead child reading online with its dot still moving. Found by
   * claude2 on review; shared from one place so the next respawn path cannot
   * miss a step.
   */
  const takeChildOffline = (verb: string): void => {
    reportActivity("end");

    try {
      if (!dao.clearAgentPid(approvalsDb, childBusHandle())) {
        // More surprising here than on an exit: a replace or restart means the
        // child has been running, so its shim should long since have registered.
        log(
          `${verb} ${childBusHandle()}, which has no bus row to take offline`,
        );
      }
    } catch (err) {
      log(
        `FAILED to take ${childBusHandle()} offline across a ${verb}: ${String(err)}`,
      );
    }
  };

  /**
   * Replace the live child, resuming its session, with different flags.
   *
   * 🛑 ONE OPERATION, THREE CALLERS, AND THAT IS THE POINT. An approval
   * changes `--allowedTools`; a model switch changes `--model`; a crash
   * restart changes nothing. All three are "kill, respawn with --resume,
   * send a prompt that explains what changed", so a model switch is a new
   * CALLER rather than new machinery. lee, 2026-10-31: *"make it easy to
   * bolt on later"*.
   *
   * ⚠️ A NEW CHILD NEEDS THE CALLBACKS REWIRED. They are registered on the
   * instance, so a replacement with no `onTurnEnd` would leave the queue
   * waiting forever for a turn that already ended.
   *
   * ⚠️ THE QUEUE IS DRAINED, NOT DISCARDED. Anything unsent is re-offered to
   * the new child; dropping it would lose work the operator never saw fail.
   */
  const replaceChild = (
    reason: string,
    change: { allowedTools?: readonly string[]; model?: string },
    prompt: string,
  ): void => {
    const unsent = queue.drain();

    log(`replacing child (${reason}); ${unsent.length} prompt(s) carried over`);
    replacingChild = true;
    child.kill();

    takeChildOffline("replacing");

    if (change.model) currentModel = change.model;

    if (change.allowedTools && currentGrant) {
      const allowed = [...change.allowedTools];
      currentGrant = {
        ...currentGrant,
        allowed,
        available: availableBuiltins(allowed),
      };

      // The grant just moved, and `can_reply` is derived from it.
      canReply.publish();
    }

    // 🛑 THE SUPERVISOR STAYS UP, per lee's ruling of 2026-11-15. It already
    // did — the socket handler catches this and answers `ok: false` — so the
    // only thing missing was saying so and keeping the work.
    //
    // ⚠️ PARKED, NOT RE-OFFERED. There is no child now, so a re-offer would
    // write to the process just killed. The next successful respawn drains
    // these and hands them over.
    //
    // The throw is re-raised so the caller still learns the spawn failed.
    try {
      child = spawnFn({
        ...opts,
        cwd: childCwd,
        grant: currentGrant,
        model: currentModel,
        // 🛑 THE SESSION, SO A CHANGE IS NOT A RESTART. Measured 2026-10-31:
        // resuming works 3 of 3 with an explicit prompt, 0 of 2 with a vague
        // one, so the prompt below is as load-bearing as the flag.
        resumeSessionId: childSession ?? opts.resumeSessionId,
        supervisorHandle: opts.handle,
        // 🛑 NAMED, BECAUSE `hostBus` IS NOT IN `opts` AND THE SPREAD CANNOT
        // CARRY IT. Omitting it made `containerized.ts` refuse a granted
        // spawn, so approving a command KILLED the agent and left its socket
        // file behind. `bus` is optional on `SpawnOptions`, so typecheck was
        // clean and the respawn tests' fake only chose whether to throw.
        bus: hostBus?.endpoint,
      });
    } catch (err) {
      // 🛑 THE DEAD CHILD'S HANDLERS ARE STILL CURRENT WITHOUT THIS, AND ITS
      // `onExit` DRAINS. `wireChild` is the only other place `childGeneration`
      // moves, and the throw path never reaches it — so the exit of the child
      // just killed passed `ifCurrent`, drained what was parked here, and
      // logged it as UNSENT. The park was defeated. Found by claude2, who
      // reproduced it twice; my own fake never fired an exit from `kill()`,
      // so no test here could have said no.
      childGeneration += 1;

      log(
        `FAILED to replace the child (${reason}): ${String(err)}; ` +
          `${unsent.length} prompt(s) parked, NO agent is running for this handle`,
      );

      // 🛑 CLEARED WHERE THE GENERATION HAS ALREADY MOVED, not in a
      // `finally`. A `finally` runs BEFORE `wireChild`, so on the success
      // path it cleared the flag while the generation was still the old
      // one — safe only because nothing awaits in between, which is a
      // timing argument this guard exists to avoid. Raised by claude2.
      replacingChild = false;

      for (const p of unsent) queue.park(p);

      throw err;
    }

    wireChild();
    replacingChild = false;
    queue.offer({ text: prompt, messageIds: [] });

    for (const p of unsent) queue.reoffer(p);
  };

  /**
   * 🛑 THE THIRD LINK, AND IT WAS DEAD WHILE TWO GUARDS SAID THE PATH WAS
   * WHOLE. `driver.redispatchPrompt` was declared on the registry and never
   * read: an operator's Approve woke the supervisor, `formatPrompt` rendered
   * it as an ordinary chat line, and the template measured at 3 of 3 never
   * ran. Found by claude1, who also noted the guard covering links 1 and 2
   * made the gap LOOK closed.
   *
   * A denied child will not retry, so a grant means a NEW invocation: the
   * child is REPLACED, resuming its session, with the one command added.
   */
  const applyAnswer = (answer: NonNullable<WakeEnvelope["approval"]>): void => {
    if (answer.decision === "deny") {
      queue.offer({
        text: `[chat-mcp] your request for \`${answer.requested}\` was DENIED by the operator. Do not retry it; carry on with what does not need it.`,
        messageIds: [],
      });

      return;
    }

    grantedCommands.push(answer.requested);

    // 🛑 THE FLAGS MUST CHANGE, NOT JUST THE PROMPT. Telling a child a
    // command is now allowed while its `--allowedTools` is unchanged earns a
    // second denial, and the prompt makes it look like the grant worked.
    replaceChild(
      `approved: ${answer.requested}`,
      // The GRANT, never the prose. An approval with no grant cannot widen
      // anything, so it re-dispatches with the allowlist unchanged — the
      // child will be denied again, visibly, rather than silently.
      {
        // Every spelling, not just the one shown. They denote one file.
        allowedTools: allowlistWith(
          currentGrant?.allowed ?? [],
          answer.grantForms?.length
            ? [...answer.grantForms]
            : answer.grant
              ? [answer.grant]
              : [],
        ),
      },
      opts.vendor.redispatchPrompt({
        // 🛑 THE COMMAND, NOT THE PROSE. `requested` is a sentence; a child
        // asked to attempt it types something no grant covers.
        grantedCommand:
          (answer.grant === null || answer.grant === undefined
            ? null
            : commandFromGrant(answer.grant)) ?? answer.requested,
        followUp: "Then carry on with the task you were on.",
      }),
    );
  };

  /**
   * A deliberate clean slate, not a resume: `resumeSessionId` is dropped so
   * the respawned child starts a brand-new session.
   */
  const RESTART_NOTICE =
    "This container is restarting. Externalize anything you need now — " +
    "this is the last turn before shutdown.";
  const GRACEFUL_RESTART_TIMEOUT_MS = 30_000;

  const SHUTDOWN_NOTICE =
    "This agent is shutting down. Externalize anything you need now — " +
    "this is the last turn before SIGTERM.";
  const shutdownGraceMs =
    (opts.shutdownGraceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS) * 1000;

  /**
   * Send `notice`, then wait up to `timeoutMs` for the current turn to end
   * before calling `onFinish` — shared by `restartChild('graceful')` and
   * `stop('graceful')` (#149), the two places this process gives a running
   * child a head start before something irreversible follows.
   *
   * 🛑 "DISPATCHED" ≠ "ITS OWN TURN ENDED". If the notice was queued behind
   * an in-flight turn, the turn-end that flushes it into dispatch and the
   * turn-end that completes its own turn are the SAME callback, called
   * once per turn — but two SEPARATE invocations, one count apart. Firing
   * on the first (dispatch) one acts the instant the child receives the
   * notice, before it can act on it (chat-mcp review, Task 8).
   */
  const sendNoticeThenFinish = (
    notice: string,
    timeoutMs: number,
    onFinish: () => void,
    // Returns a short-circuit. Calling it runs `onFinish` now and cancels the
    // wait, which is how `agents stop --now` escalates a graceful stop still
    // inside its grace period.
  ): (() => void) => {
    let noticeDispatchedAtCount: number | null = null;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      const turnIdx = turnEndListeners.indexOf(onAnyTurnEnd);
      if (turnIdx >= 0) turnEndListeners.splice(turnIdx, 1);
      const sendIdx = sendListeners.indexOf(onSend);
      if (sendIdx >= 0) sendListeners.splice(sendIdx, 1);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      onFinish();
    };

    const timer = setTimeout(finish, timeoutMs);

    const onAnyTurnEnd = (): void => {
      if (noticeDispatchedAtCount === null) return;
      if (turnEndCount <= noticeDispatchedAtCount) return;
      finish();
    };

    const onSend = (prompt: {
      text: string;
      messageIds: readonly number[];
    }): void => {
      if (prompt.text !== notice || noticeDispatchedAtCount !== null) return;
      noticeDispatchedAtCount = turnEndCount;
    };

    turnEndListeners.push(onAnyTurnEnd);
    sendListeners.push(onSend);

    queue.offer({ text: notice, messageIds: [] });

    return finish;
  };

  const doRestart = (): void => {
    const unsent = queue.drain();
    log(`restarting child (${unsent.length} prompt(s) carried over)`);
    replacingChild = true;
    child.kill();
    takeChildOffline("restarting");
    childSession = null;
    needsMountBanner = isContainerSpawn;

    // 🛑 THE SUPERVISOR STAYS UP, per lee's ruling of 2026-11-15. It already
    // did — the socket handler catches this and answers `ok: false` — so the
    // only thing missing was saying so and keeping the work.
    //
    // ⚠️ PARKED, NOT RE-OFFERED. There is no child now, so a re-offer would
    // write to the process just killed. The next successful respawn drains
    // these and hands them over.
    //
    // The throw is re-raised so the caller still learns the spawn failed.
    try {
      child = spawnFn({
        ...opts,
        cwd: childCwd,
        grant: currentGrant,
        model: currentModel,
        supervisorHandle: opts.handle,
        resumeSessionId: undefined,
        bus: hostBus?.endpoint,
      });
    } catch (err) {
      // 🛑 THE DEAD CHILD'S HANDLERS ARE STILL CURRENT WITHOUT THIS, AND ITS
      // `onExit` DRAINS. `wireChild` is the only other place `childGeneration`
      // moves, and the throw path never reaches it — so the exit of the child
      // just killed passed `ifCurrent`, drained what was parked here, and
      // logged it as UNSENT. The park was defeated. Found by claude2, who
      // reproduced it twice; my own fake never fired an exit from `kill()`,
      // so no test here could have said no.
      childGeneration += 1;

      log(
        `FAILED to restart the child: ${String(err)}; ` +
          `${unsent.length} prompt(s) parked, NO agent is running for this handle`,
      );

      // 🛑 CLEARED WHERE THE GENERATION HAS ALREADY MOVED, not in a
      // `finally`. A `finally` runs BEFORE `wireChild`, so on the success
      // path it cleared the flag while the generation was still the old
      // one — safe only because nothing awaits in between, which is a
      // timing argument this guard exists to avoid. Raised by claude2.
      replacingChild = false;

      for (const p of unsent) queue.park(p);

      throw err;
    }

    wireChild();
    offerHandoffPointer(true);
    replacingChild = false;

    for (const p of unsent) queue.reoffer(p);
  };

  const restartChild = (mode: "graceful" | "now"): void => {
    if (mode === "now") {
      doRestart();
      return;
    }

    sendNoticeThenFinish(
      RESTART_NOTICE,
      GRACEFUL_RESTART_TIMEOUT_MS,
      doRestart,
    );
  };

  // See `runGracefulRestart`: the context gauge reaches the restart through
  // this, because its callback is registered before this const exists.
  runGracefulRestart = () => restartChild("graceful");

  /**
   * Set while a graceful stop is waiting out its grace period. Calling it ends
   * that wait immediately.
   *
   * 🛑 THIS IS WHAT MAKES `--now` ESCALATE A GRACEFUL STOP. Without it the
   * second command is refused and the operator waits out the original grace
   * believing they cut it short — which is #136's own symptom, reintroduced
   * one layer up. Found by claude2 reviewing PR #158.
   */
  let cancelGracefulWait: (() => void) | null = null;

  const doStop = async (mode: "graceful" | "now"): Promise<void> => {
    // A bus-delivered stop and the CLI's SIGINT handler can both land, and the
    // second one must not re-close the socket or fire `onStopped` twice.
    if (hasStopped) {
      if (mode === "now") cancelGracefulWait?.();

      return;
    }
    hasStopped = true;

    if (mode === "graceful") {
      await new Promise<void>((resolve) => {
        cancelGracefulWait = sendNoticeThenFinish(
          SHUTDOWN_NOTICE,
          shutdownGraceMs,
          resolve,
        );
      });
      cancelGracefulWait = null;
    }

    // 🛑 `kill()` RETURNS BEFORE THE CONTAINER IS DOWN. It spawns `docker stop`
    // detached on purpose, so firing `onStopped` here reports "stopped" while
    // the container is still shutting down. The wait is what makes the printed
    // confirmation true.
    const current = child;
    current.kill();
    await current.awaitTeardown?.();

    // 🛑 THE TEARDOWN IS AWAITED BEFORE THE SOCKET CLOSES, AND THAT ORDER IS
    // THE ONE SIGNAL `agents stop` CAN WAIT ON for every driver — a host child
    // has no container to poll.
    await finishShutdown();
  };

  onWake = (envelope): WakeAck => {
    // 🛑 A STOP IS CHECKED BEFORE THE STOPPING GUARD, so `--now` can escalate a
    // graceful stop mid-grace. Refusing it would tell the operator their
    // escalation landed while they wait out the original period — #136's own
    // symptom. `doStop` is idempotent and handles the upgrade itself.
    if (envelope.control?.kind === "stop") {
      const mode = envelope.control.mode;
      // A stop closes the very socket this ack travels back on, so it CANNOT
      // run inline. Deferring lets the ack reach the CLI before the listener
      // dies — otherwise `agents stop` reports no supervisor was listening.
      setImmediate(() => void doStop(mode));

      // The CLI's wait ceiling comes from HERE rather than its own copy of the
      // default, so a per-handle `shutdownGraceSeconds` cannot make a healthy
      // stop report failure. Found by claude2 reviewing PR #158.
      return {
        ok: true,
        queued: "sent",
        graceSeconds: Math.ceil(shutdownGraceMs / 1000),
      };
    }

    // 🛑 THE SOCKET OUTLIVES THE CHILD DURING A TEARDOWN, by up to the full
    // grace period. Without this a wake in that window is "delivered" to a
    // child that is already being killed, and the sender is told `sent`.
    if (hasStopped) {
      return { ok: false, error: "supervisor is stopping" };
    }

    // A restart command is out-of-band, not a chat message or an approval,
    // and must run before either of those checks.
    if (envelope.control?.kind === "restart") {
      restartChild(envelope.control.mode);

      return { ok: true, queued: "sent" };
    }

    // An answer is not a chat message and must not be rendered as one.
    // 🛑 AN ANSWER REPLACES THE CHILD AND QUEUES ITS OWN PROMPT, so there is
    // nothing left for this path to send. Routing it on would deliver the
    // re-dispatch text twice.
    if (envelope.approval) {
      applyAnswer(envelope.approval);

      return { ok: true, queued: "sent" };
    }

    // 🛑 ONE CALL YIELDS BOTH, so the prompt that says a reply is owed is
    // exactly the prompt whose silence is reported back. Computing `owedTo`
    // here from its own test is what let the two disagree.
    const rendered = formatPrompt(envelope, childCanSend());

    const prompt = {
      text: `${mountBannerPrefix()}${rendered.text}`,
      messageIds: envelope.id > 0 ? [envelope.id] : [],
      ...(rendered.owedTo ? { owedTo: rendered.owedTo } : {}),
    };

    const verdict = gate.verdict();

    if (!verdict.allow) {
      held.push(prompt);
      log(`HELD: ${verdict.reason}`);

      // The sender learns the message is safe but waiting, and why. A file
      // write could never say either.
      return { ok: true, queued: "held", error: verdict.reason };
    }

    // The ack tells the SENDER what happened, which a file write never could.
    return { ok: true, queued: queue.offer(prompt) };
  };

  log(`supervisor listening for [${opts.handle}] at ${listener.socketPath}`);

  // 🛑 A PRODUCTION CALLER FOR describe(), WHICH PREVIOUSLY HAD NONE — it was
  // reachable only from tests, the same dead-code shape the gate itself had
  // one commit earlier. Logged at startup so an UNMETERED driver announces
  // itself before it dispatches anything, rather than never.
  log(gate.describe());

  // 🛑 THE SAME ANNOUNCE, FOR THE OTHER GAUGE. A driver that reports no
  // context dispatches anyway and says so here — lee, 2026-11-13: *"dispatch
  // and announce the blank"*. Without this line a blank gauge and a broken
  // one look identical to an operator. #217.
  log(describeContextGauge(child.reportsContext));

  return {
    socketPath: listener.socketPath,
    get queueDepth(): number {
      return queue.depth;
    },
    get heldDepth(): number {
      return held.length;
    },
    rateLimits(): string {
      return gate.describe();
    },
    onTurnEnd(cb: () => void): void {
      turnEndListeners.push(cb);
    },
    onStopped(cb: () => void): void {
      stoppedListeners.push(cb);
    },
    async stop(mode: "graceful" | "now" = "now"): Promise<void> {
      await doStop(mode);
    },
  };
}
