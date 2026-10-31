import type { AgentChild, SpawnOptions } from './child.js';
import { driverFor } from './drivers/index.js';
import { TurnQueue } from './turn-queue.js';
import { WakeListener, type WakeAck, type WakeEnvelope } from './socket.js';
import { RateLimitGate } from './rate-limit.js';
import { openDb } from '../storage/db.js';
import * as dao from '../storage/dao.js';
import {
  DEFAULT_ALLOWED,
  DEFAULT_EXTRA_DIRS,
  availableBuiltins,
  childHandleFor,
  type ChildGrant,
} from './grant.js';
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
function buildGrant(opts: SupervisorOptions): ChildGrant | undefined {
  if (opts.reply === false) return undefined;

  const handle = childHandleFor(opts.handle);

  const allowed = opts.allowedTools ?? DEFAULT_ALLOWED;

  return {
    handle,
    configPath: writeClaudeMcpConfig(handle),
    allowed,
    available: availableBuiltins(allowed),
    extraDirs: opts.extraDirs ?? DEFAULT_EXTRA_DIRS,
  };
}

export async function startSupervisor(opts: SupervisorOptions): Promise<Supervisor> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const driver = driverFor(opts.driver ?? 'claude');

  // 🛑 THROWS BEFORE ANYTHING SPAWNS. A child's cwd is reachable by
  // definition, so an unvalidated one is a containment hole that no
  // allowlist or directory list can close.
  const childCwd = resolveCwd(opts.cwd, opts.extraDirs ?? DEFAULT_EXTRA_DIRS);
  // Injected in tests; the real one is the shared bus database the web UI
  // already reads.
  const approvalsDb = opts.db ?? openDb();
  const spawnFn = opts.spawnChild ?? driver.spawn;

  const grant = opts.grant ?? buildGrant(opts);
  const child = spawnFn({ ...opts, cwd: childCwd, grant });

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

  // 🛑 SEMANTIC CALLBACKS ONLY. Nothing here knows Claude Code's event shapes —
  // the driver maps its own. That is what makes a Cursor or other CLI driver a
  // new file rather than a change to the queue and the gate.
  child.onTurnEnd(() => {
    queue.turnEnded();
    log(`← turn complete; ${queue.depth} queued, ${held.length} held`);
  });

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

  let childSession: string | null = null;
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
    // 🛑 Anything queued is UNSENT. Reporting it is the difference between a
    // visible gap and silence, and silence is the ambiguity this whole change
    // exists to remove.
    const unsent = queue.drain();
    log(`child exited code=${code} signal=${signal}; ${unsent.length} prompt(s) never sent`);

    for (const p of unsent) log(`  UNSENT ids=[${p.messageIds.join(',')}]`);
  });

  /**
   * 🛑 THE THIRD LINK, AND IT WAS DEAD WHILE TWO GUARDS SAID THE PATH WAS
   * WHOLE. `driver.redispatchPrompt` was declared on the registry and never
   * read: an operator's Approve woke the supervisor, `formatPrompt` rendered
   * it as an ordinary chat line, and the template measured at 3 of 3 never
   * ran. Found by claude1, who also noted the guard covering links 1 and 2
   * made the gap LOOK closed.
   *
   * A denied child will not retry, so a grant means a NEW invocation: the
   * child is replaced, resuming its session, with the one command added.
   */
  const applyAnswer = (answer: NonNullable<WakeEnvelope['approval']>): string => {
    if (answer.decision === 'deny') {
      return `[chat-mcp] your request for \`${answer.requested}\` was DENIED by the operator. Do not retry it; carry on with what does not need it.`;
    }

    grantedCommands.push(answer.requested);
    log(`APPROVED: ${answer.requested} — re-dispatching with the session resumed`);

    return driver.redispatchPrompt({
      grantedCommand: answer.requested,
      followUp: 'Then carry on with the task you were on.',
    });
  };

  const listener = await WakeListener.bind(opts.handle, (envelope): WakeAck => {
    // An answer is not a chat message and must not be rendered as one.
    const prompt = {
      text: envelope.approval ? applyAnswer(envelope.approval) : formatPrompt(envelope),
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
