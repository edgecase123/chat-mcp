import type { AgentChild, SpawnOptions } from './child.js';
import { driverFor } from './drivers/index.js';
import { TurnQueue } from './turn-queue.js';
import { WakeListener, type WakeAck, type WakeEnvelope } from './socket.js';
import { RateLimitGate } from './rate-limit.js';
import { openDb } from '../storage/db.js';
import * as dao from '../storage/dao.js';
import { availableBuiltins, childHandleFor, defaultAllowed, type ChildGrant } from './grant.js';
import { dirsFor } from './projects.js';
import { allowlistWith, resolveCwd } from './allowlist.js';
import { writeClaudeMcpConfig } from './drivers/claude.js';

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

  /** Injected so the supervisor is testable without touching the real bus. */
  readonly db?: Parameters<typeof dao.insertApproval>[0];

  /** Injected so the supervisor is testable without spawning or spending. */
  readonly spawnChild?: (opts: SpawnOptions) => AgentChild;
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
  stop(): Promise<void>;
}

/** How an arriving message is presented to the agent. */
export function formatPrompt(envelope: WakeEnvelope): string {
  const from = envelope.from || 'unknown';
  const body = envelope.body?.trim();
  const where = envelope.to.startsWith('#') ? ` in ${envelope.to}` : '';

  // 🛑 An `alert` is BLOCKING by this bus's own definition. Rendering it the
  // same as a chat message loses the urgency at the layer built to deliver it
  // faster, so the escalation is in the prompt text and not left to the
  // agent to infer from a field it may not read.
  const banner =
    envelope.kind === 'alert'
      ? '🚨 ALERT — BLOCKING. This was sent as high-severity; handle it before anything queued behind it.\n\n'
      : envelope.kind === 'dispatch'
        ? '📋 DISPATCH — a task hand-off, not a status update.\n\n'
        : '';

  if (!body) {
    // 🛑 No body means this came through the FALLBACK file path, which
    // overwrites and carries no payload. Say so rather than inventing one —
    // the agent must know to go and read the bus itself.
    return `${banner}[chat-mcp] ${from}${where} sent you something (id ${envelope.id}). The wake carried no body, so read your inbox.`;
  }

  return `${banner}[chat-mcp] ${from}${where}:\n\n${body}`;
}

/**
 * The child's bus identity and tool grant, or undefined when replies are off.
 *
 * Derived from the supervisor's handle rather than configured, so the two can
 * never be made equal by forgetting a flag — a child sharing the supervisor's
 * handle consumes the deliveries meant for it (chat-mcp#35).
 */
function buildGrant(opts: SupervisorOptions, dirs: readonly string[]): ChildGrant | undefined {
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

export async function startSupervisor(opts: SupervisorOptions): Promise<Supervisor> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const driver = driverFor(opts.driver ?? 'claude');

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
  const childCwd = resolveCwd(opts.cwd, dirs);
  // Injected in tests; the real one is the shared bus database the web UI
  // already reads.
  const approvalsDb = opts.db ?? openDb();
  const spawnFn = opts.spawnChild ?? driver.spawn;

  const grant = opts.grant ?? buildGrant(opts, dirs);

  /**
   * The live child. Mutable, because replacing it is a first-class operation.
   *
   * 🛑 IT USED TO BE `const` AND SPAWNED EXACTLY ONCE, which is how the
   * approval path stayed broken after it looked fixed: a grant recorded the
   * command, sent the child a prompt saying it was now allowed, and never
   * changed the child's `--allowedTools`. The next attempt was denied again.
   * `grantedCommands` was written and never read.
   */
  let child = spawnFn({ ...opts, cwd: childCwd, grant });
  let currentGrant = grant;
  let currentModel = opts.model;

  // 🛑 SAID OUT LOUD, both ways. A doorbell that cannot answer and a child
  // holding a bus identity are both things an operator must be able to see in
  // the log rather than deduce from a flag they did not pass.
  log(
    grant
      ? `child acts as "${grant.handle}"; ${grant.allowed.length} allowed tool(s), built-ins: ${grant.available.join(' ')}`
      : 'child has NO grant — it can be woken and can do nothing (--no-reply)',
  );
  const gate = new RateLimitGate(opts.utilizationCeiling ?? 0.9, child.reportsUsage);

  /**
   * Accepted but not dispatched, because the window was too full.
   *
   * 🛑 HELD, NOT DROPPED. Refusing to spend a turn must not lose the message —
   * that would trade a cost problem for a correctness one. These are released
   * the moment a rate-limit event says there is room.
   */
  const held: { text: string; messageIds: number[] }[] = [];

  const queue = new TurnQueue({
    send: (prompt) => {
      log(`→ child: ${prompt.text.slice(0, 80).replace(/\n/g, ' ')}`);
      child.send(prompt.text);
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

  let childSession: string | null = null;

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

    child.onTurnEnd(() => {
      queue.turnEnded();
      log(`← turn complete; ${queue.depth} queued, ${held.length} held`);
    });

    child.onSession((id) => {
      childSession = id;
    });

    child.onDenial((denial) => {
      const grantHandle = grant?.handle ?? `${opts.handle}-agent`;

      try {
        const approvalId = dao.insertApproval(approvalsDb, {
          agentHandle: grantHandle,
          supervisorHandle: opts.handle,
          // ⚠️ VERBATIM, and null when the clause could not be parsed. The
          // operator approves this exact string and it is what gets
          // allowlisted, so a guess would grant what the child never asked for.
          requested: denial.requested ?? '(could not parse the request)',
          reason: denial.raw,
          sessionId: childSession,
        });

        log(`child BLOCKED, approval ${approvalId} pending: ${denial.requested ?? 'unparsed'}`);
      } catch (err) {
        // 🛑 SAY SO. A failed write here means the operator is never asked, and
        // silence is the failure mode this whole path exists to remove.
        log(`FAILED to record a denial — nobody will be asked: ${String(err)}`);
      }
    });

    child.onUsage((snapshot) => {
      gate.update(snapshot);
      log(gate.describe());
      releaseHeld();
    });

    child.onExit((code, signal) => {
      // 🚨 THE DEAD CHILD'S EXIT MUST NOT TOUCH THE LIVE QUEUE. `kill()`
      // fires this AFTER a replacement is already running, so draining here
      // threw away the carried-over work AND reset the queue to idle
      // mid-turn — two turns in flight at once. Found by claude1.
      if (generation !== childGeneration) {
        log(`old child exited code=${code} signal=${signal} (replaced); ignoring`);

        return;
      }

      // 🛑 Anything queued is UNSENT. Reporting it is the difference between a
      // visible gap and silence, and silence is the ambiguity this whole change
      // exists to remove.
      const unsent = queue.drain();
      log(`child exited code=${code} signal=${signal}; ${unsent.length} prompt(s) never sent`);

      for (const p of unsent) log(`  UNSENT ids=[${p.messageIds.join(',')}]`);
    });



  }

  wireChild();

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
    child.kill();

    if (change.model) currentModel = change.model;

    if (change.allowedTools && currentGrant) {
      const allowed = [...change.allowedTools];
      currentGrant = { ...currentGrant, allowed, available: availableBuiltins(allowed) };
    }

    child = spawnFn({
      ...opts,
      cwd: childCwd,
      grant: currentGrant,
      model: currentModel,
      // 🛑 THE SESSION, SO A CHANGE IS NOT A RESTART. Measured 2026-10-31:
      // resuming works 3 of 3 with an explicit prompt, 0 of 2 with a vague
      // one, so the prompt below is as load-bearing as the flag.
      resumeSessionId: childSession ?? opts.resumeSessionId,
    });

    wireChild();
    queue.offer({ text: prompt, messageIds: [] });

    for (const p of unsent) queue.offer(p);
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
  const applyAnswer = (answer: NonNullable<WakeEnvelope['approval']>): void => {
    if (answer.decision === 'deny') {
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
      { allowedTools: allowlistWith(currentGrant?.allowed ?? [], [answer.requested]) },
      driver.redispatchPrompt({
        grantedCommand: answer.requested,
        followUp: 'Then carry on with the task you were on.',
      }),
    );
  };

  const listener = await WakeListener.bind(opts.handle, (envelope): WakeAck => {
    // An answer is not a chat message and must not be rendered as one.
    // 🛑 AN ANSWER REPLACES THE CHILD AND QUEUES ITS OWN PROMPT, so there is
    // nothing left for this path to send. Routing it on would deliver the
    // re-dispatch text twice.
    if (envelope.approval) {
      applyAnswer(envelope.approval);

      return { ok: true, queued: 'sent' };
    }

    const prompt = {
      text: formatPrompt(envelope),
      messageIds: envelope.id > 0 ? [envelope.id] : [],
    };

    const verdict = gate.verdict();

    if (!verdict.allow) {
      held.push(prompt);
      log(`HELD: ${verdict.reason}`);

      // The sender learns the message is safe but waiting, and why. A file
      // write could never say either.
      return { ok: true, queued: 'held', error: verdict.reason };
    }

    // The ack tells the SENDER what happened, which a file write never could.
    return { ok: true, queued: queue.offer(prompt) };
  });

  log(`supervisor listening for [${opts.handle}] at ${listener.socketPath}`);

  // 🛑 A PRODUCTION CALLER FOR describe(), WHICH PREVIOUSLY HAD NONE — it was
  // reachable only from tests, the same dead-code shape the gate itself had
  // one commit earlier. Logged at startup so an UNMETERED driver announces
  // itself before it dispatches anything, rather than never.
  log(gate.describe());

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
    async stop(): Promise<void> {
      await listener.close();
      child.kill();
    },
  };
}
