import type { AgentChild, SpawnOptions } from './child.js';
import { assertDeclaresCapabilities } from './child.js';
import type { VendorSpawn } from './vendor.js';
import { resolveDriver } from './drivers/index.js';
import { spawnOnHost } from './drivers/host.js';
import { spawnContainerized, DEFAULT_SHUTDOWN_GRACE_SECONDS } from './drivers/containerized.js';
import { TurnQueue } from './turn-queue.js';
import { WakeListener, refuseIfSupervisorLive, type WakeAck, type WakeEnvelope } from './socket.js';
import { RateLimitGate } from './rate-limit.js';
import { openDb } from '../storage/db.js';
import * as dao from '../storage/dao.js';
import { availableBuiltins, childHandleFor, defaultAllowed, type ChildGrant } from './grant.js';
import { dirsFor } from './projects.js';
import { allowlistWith, resolveCwd } from './allowlist.js';
import { commandFromGrant, grantFor, grantVariants } from './denial.js';
import { writeClaudeMcpConfig } from './drivers/claude.js';
import {
  describeChildOutput,
  describeTurnResult,
  excerptForLog,
} from './drivers/claude-events.js';
import { openHostBus, type HostBus } from './host-bus.js';
import { applyContextReport } from '../shim/gauge-report.js';
import type { ContextSnapshot } from './context-gauge.js';
import { describeContextGauge } from './context-gauge.js';

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
  stop(mode?: 'graceful' | 'now'): Promise<void>;
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
  // 🛑 FIRST STATEMENT, BEFORE ANYTHING WRITES OR SPAWNS. lee ruled on
  // 2026-11-11 that a second supervisor refuses rather than taking over.
  // Refusing here rather than at the `bind` below keeps two destructive steps
  // out of the rejected path: the child's MCP config, which is written per
  // handle and would clobber the live supervisor's, and the containerized
  // spawn's `docker rm -f` (#154).
  await refuseIfSupervisorLive(opts.handle);

  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const selection = resolveDriver({ driver: opts.driver, container: opts.container });

  // 🛑 THE MODE IS THE GATE, NOT A DRIVER-NAME STRING. `resolveDriver` already
  // folds `--driver docker-claude` and `--container` into one `SandboxMode`,
  // so every container-only decision in this function (mount banner included)
  // reads `selection.mode` rather than re-deriving container-ness from a name
  // a second vendor could spell differently.
  const isContainerSpawn = selection.mode === 'docker';

  if (isContainerSpawn) {
    const { readToken } = await import('./auth.js');
    const { isConfirmed } = await import('./container.js');

    if (!readToken()) {
      throw new Error(
        'no Claude OAuth token on file; run `claude setup-token` on the host, then ' +
          '`pbpaste | chat-mcp auth set-token` (stdin, never argv)',
      );
    }
    if (!isConfirmed(opts.handle)) {
      throw new Error(
        `container plan for "${opts.handle}" is not confirmed; run ` +
          `\`chat-mcp supervise ${opts.handle} --container\` interactively once first`,
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

  const { mountsFor, containerPathFor } = await import('./mounts.js');

  let needsMountBanner = isContainerSpawn && !opts.resumeSessionId;

  const mountBannerPrefix = (): string => {
    if (!needsMountBanner) return '';
    needsMountBanner = false;

    const entries = Object.entries(mountsFor(opts.handle)).map(
      ([key]) => `${key} -> ${containerPathFor(key)}`,
    );

    return entries.length === 0 ? '' : `Mounted directories: ${entries.join(', ')}.\n\n`;
  };

  const childCwd = resolveCwd(opts.cwd, dirs);
  // Injected in tests; the real one is the shared bus database the web UI
  // already reads.
  const approvalsDb = opts.db ?? openDb();
  const spawnRaw =
    opts.spawnChild ??
    ((o: SpawnOptions) =>
      selection.mode === 'docker'
        ? spawnContainerized(opts.vendor, o)
        : spawnOnHost(opts.vendor, o));

  // 🛑 WRAPPED ONCE, NOT ASSERTED AT EACH CALL SITE. The child is spawned in
  // three places — first start, restart, replace — and a guard repeated three
  // times is a guard that will be two next time someone adds a fourth.
  const spawnFn = (o: SpawnOptions): AgentChild => {
    const spawned = spawnRaw(o);

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
        log(`could not kill the child of an undeclared driver: ${String(killErr)}`);
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
  /**
   * 🛑 OPENED BEFORE THE SPAWN, BECAUSE THE CHILD IS CONFIGURED WITH ITS URL.
   * A containerized child reaches the bus over HTTP and nothing else — the
   * state-dir mount that used to carry it is gone, so without this the spawn
   * refuses rather than starting an agent that answers nothing.
   *
   * Host children keep the stdio shim, which needs no socket.
   */
  const hostBus: HostBus | undefined =
    isContainerSpawn && initialGrant ? await openHostBus(initialGrant.handle) : undefined;

  let onWake: ((envelope: WakeEnvelope) => WakeAck) | null = null;

  const listener = await WakeListener.bind(opts.handle, (envelope): WakeAck => {
    // 🛑 FIRST STATEMENT, ABOVE THE STOP BRANCH, AND THE ORDER IS THE POINT.
    // The real handler closes over eight bindings declared below the spawn.
    // The first it touches is `doStop`, inside a `setImmediate`, where a
    // temporal-dead-zone throw lands outside this call stack and takes the
    // supervisor down instead of refusing a wake. lee ruled on 2026-11-11 that
    // a wake arriving here is refused rather than queued.
    if (onWake === null) return { ok: false, error: 'supervisor is still starting' };

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
  const childBusHandle = () => currentGrant?.handle ?? childHandleFor(opts.handle);

  // 🛑 SAID OUT LOUD, both ways. A doorbell that cannot answer and a child
  // holding a bus identity are both things an operator must be able to see in
  // the log rather than deduce from a flag they did not pass.
  log(
    initialGrant
      ? `child acts as "${initialGrant.handle}"; ${initialGrant.allowed.length} allowed tool(s), ` +
        `built-ins: ${initialGrant.available.join(' ')}`
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
  const sendListeners: ((prompt: { text: string; messageIds: readonly number[] }) => void)[] = [];

  /**
   * Counts each onTurnEnd invocation, incremented BEFORE `queue.turnEnded()`
   * runs. A prompt dispatched from inside one turn-end call (because it was
   * queued behind an in-flight turn) and the turn-end that completes that
   * SAME prompt's own turn are two different calls one count apart — this
   * is how a graceful restart tells them apart. See `restartChild`.
   */
  let turnEndCount = 0;

  const queue = new TurnQueue({
    send: (prompt) => {
      log(`→ child: ${excerptForLog(prompt.text)}`);
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
    const ifCurrent = <A extends unknown[]>(label: string, fn: (...args: A) => void) => {
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
    child.onEvent(
      ifCurrent('onEvent', (event) => {
        const said = describeChildOutput(event);

        if (said) log(`← child: ${said}`);

        const outcome = describeTurnResult(event);

        if (outcome) log(`← result: ${outcome}`);
      }),
    );

    child.onTurnEnd(
      ifCurrent('onTurnEnd', () => {
        turnEndCount++;
        queue.turnEnded();
        log(`← turn complete; ${queue.depth} queued, ${held.length} held`);

        // ⚠️ AFTER the queue is settled, so an observer that reacts by
        // reading state does not see a half-drained queue.
        for (const cb of turnEndListeners) cb();
      }),
    );

    child.onSession(
      ifCurrent('onSession', (id) => {
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
      ifCurrent('onContext', (snapshot: ContextSnapshot) => {
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

          // 🛑 AN UPDATE AGAINST A MISSING ROW IS A SILENT NO-OP, which is the
          // exact failure class this ticket exists to end. The row is written
          // by the SHIM when the child registers, so a reading can arrive
          // first.
          if (!dao.getAgent(approvalsDb, childHandle)) {
            if (!warnedUnregisteredGauge) {
              warnedUnregisteredGauge = true;
              log(`context gauge: ${childHandle} has not registered on the bus yet; not reporting`);
            }

            return;
          }

          if (snapshot.totalIsFallback && !warnedFallbackWindows.has(snapshot.model ?? '')) {
            warnedFallbackWindows.add(snapshot.model ?? '');
            log(
              `context gauge: no window size known for model "${snapshot.model ?? 'unreported'}"; ` +
                `using ${snapshot.total} — the percentage is only as right as that guess`,
            );
          }

          // Clamp rather than refuse: a real window larger than the mapped one
          // means the map is stale, and a gauge pinned at 100% still says full.
          applyContextReport(
            approvalsDb,
            childHandle,
            Math.min(snapshot.used, snapshot.total),
            snapshot.total,
          );
        } catch (err) {
          log(`FAILED to record the context gauge: ${String(err)}`);
        }
      }),
    );

    child.onDenial(
      ifCurrent('onDenial', (denial) => {
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
          log(`FAILED to record a denial — nobody will be asked: ${String(err)}`);
        }
      }),
    );

    child.onUsage(
      ifCurrent('onUsage', (snapshot) => {
        gate.update(snapshot);
        log(gate.describe());
        releaseHeld();
      }),
    );

    child.onExit(
      ifCurrent('onExit', (code, signal) => {
      // 🛑 Anything queued is UNSENT. Reporting it is the difference between a
      // visible gap and silence, and silence is the ambiguity this whole change
      // exists to remove.
        const unsent = queue.drain();
        log(`child exited code=${code} signal=${signal}; ${unsent.length} prompt(s) never sent`);

        for (const p of unsent) log(`  UNSENT ids=[${p.messageIds.join(',')}]`);

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
          log(`FAILED to take ${childBusHandle()} offline on the bus: ${String(err)}`);
        }
      }),
    );



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

    // 🛑 HERE, NOT IN `onExit`. `kill()` returns immediately — a containerized
    // child spawns `docker stop` detached — so the exit lands after
    // `wireChild()` has bumped the generation and `ifCurrent` drops it as
    // stale. The handler below would never run, and `online` stayed true for a
    // child that no longer existed, forever if the respawn then failed.
    //
    // ⚠️ Moving the `onExit` clear outside `ifCurrent` is NOT the alternative:
    // that clears a LIVE child's pid on every stale signal. The replacement
    // re-registers its own pid moments later, so a brief offline window here
    // is the honest reading.
    //
    // ⚠️ BEFORE `spawnFn`, deliberately. A spawn that throws then leaves
    // `pid = NULL` and the bus honest rather than advertising a child that
    // never started.
    try {
      if (!dao.clearAgentPid(approvalsDb, childBusHandle())) {
        // More surprising here than on an exit: a replace means the child has
        // been running, so its shim should long since have registered.
        log(`replacing ${childBusHandle()}, which has no bus row to take offline`);
      }
    } catch (err) {
      log(`FAILED to take ${childBusHandle()} offline across a replace: ${String(err)}`);
    }

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
      supervisorHandle: opts.handle,
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
      // The GRANT, never the prose. An approval with no grant cannot widen
      // anything, so it re-dispatches with the allowlist unchanged — the
      // child will be denied again, visibly, rather than silently.
      {
        // Every spelling, not just the one shown. They denote one file.
        allowedTools: allowlistWith(
          currentGrant?.allowed ?? [],
          answer.grantForms?.length ? [...answer.grantForms] : answer.grant ? [answer.grant] : [],
        ),
      },
      opts.vendor.redispatchPrompt({
        // 🛑 THE COMMAND, NOT THE PROSE. `requested` is a sentence; a child
        // asked to attempt it types something no grant covers.
        grantedCommand:
          (answer.grant === null || answer.grant === undefined
            ? null
            : commandFromGrant(answer.grant)) ?? answer.requested,
        followUp: 'Then carry on with the task you were on.',
      }),
    );
  };

  /**
   * A deliberate clean slate, not a resume: `resumeSessionId` is dropped so
   * the respawned child starts a brand-new session.
   */
  const RESTART_NOTICE =
    'This container is restarting. Externalize anything you need now — ' +
    'this is the last turn before shutdown.';
  const GRACEFUL_RESTART_TIMEOUT_MS = 30_000;

  const SHUTDOWN_NOTICE =
    'This agent is shutting down. Externalize anything you need now — ' +
    'this is the last turn before SIGTERM.';
  const shutdownGraceMs = (opts.shutdownGraceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS) * 1000;

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

    const onSend = (prompt: { text: string; messageIds: readonly number[] }): void => {
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
    child.kill();
    childSession = null;
    needsMountBanner = isContainerSpawn;

    child = spawnFn({
      ...opts,
      cwd: childCwd,
      grant: currentGrant,
      model: currentModel,
      supervisorHandle: opts.handle,
      resumeSessionId: undefined,
    });

    wireChild();
    for (const p of unsent) queue.offer(p);
  };

  const restartChild = (mode: 'graceful' | 'now'): void => {
    if (mode === 'now') {
      doRestart();
      return;
    }

    sendNoticeThenFinish(RESTART_NOTICE, GRACEFUL_RESTART_TIMEOUT_MS, doRestart);
  };

  let hasStopped = false;
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

  const doStop = async (mode: 'graceful' | 'now'): Promise<void> => {
    // A bus-delivered stop and the CLI's SIGINT handler can both land, and the
    // second one must not re-close the socket or fire `onStopped` twice.
    if (hasStopped) {
      if (mode === 'now') cancelGracefulWait?.();

      return;
    }
    hasStopped = true;

    if (mode === 'graceful') {
      await new Promise<void>((resolve) => {
        cancelGracefulWait = sendNoticeThenFinish(SHUTDOWN_NOTICE, shutdownGraceMs, resolve);
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

    // 🛑 CLOSED AFTER THE TEARDOWN, NOT BEFORE, SO THE SOCKET'S DISAPPEARANCE
    // MEANS "FULLY STOPPED". That is the one signal `agents stop` can wait on
    // for every driver — a host child has no container to poll. Envelopes
    // arriving in this window are refused above, not delivered to a dead child.
    await listener.close();
    await hostBus?.close();

    // Registration happens in the CHILD, via the shim. So this deletes a row
    // this process did not write, which is why it is opt-in and not default.
    if (opts.ephemeral === true) dao.deleteAgent(approvalsDb, opts.handle);

    for (const cb of stoppedListeners) cb();
  };

  onWake = (envelope): WakeAck => {
    // 🛑 A STOP IS CHECKED BEFORE THE STOPPING GUARD, so `--now` can escalate a
    // graceful stop mid-grace. Refusing it would tell the operator their
    // escalation landed while they wait out the original period — #136's own
    // symptom. `doStop` is idempotent and handles the upgrade itself.
    if (envelope.control?.kind === 'stop') {
      const mode = envelope.control.mode;
      // A stop closes the very socket this ack travels back on, so it CANNOT
      // run inline. Deferring lets the ack reach the CLI before the listener
      // dies — otherwise `agents stop` reports no supervisor was listening.
      setImmediate(() => void doStop(mode));

      // The CLI's wait ceiling comes from HERE rather than its own copy of the
      // default, so a per-handle `shutdownGraceSeconds` cannot make a healthy
      // stop report failure. Found by claude2 reviewing PR #158.
      return { ok: true, queued: 'sent', graceSeconds: Math.ceil(shutdownGraceMs / 1000) };
    }

    // 🛑 THE SOCKET OUTLIVES THE CHILD DURING A TEARDOWN, by up to the full
    // grace period. Without this a wake in that window is "delivered" to a
    // child that is already being killed, and the sender is told `sent`.
    if (hasStopped) {
      return { ok: false, error: 'supervisor is stopping' };
    }

    // A restart command is out-of-band, not a chat message or an approval,
    // and must run before either of those checks.
    if (envelope.control?.kind === 'restart') {
      restartChild(envelope.control.mode);

      return { ok: true, queued: 'sent' };
    }

    // An answer is not a chat message and must not be rendered as one.
    // 🛑 AN ANSWER REPLACES THE CHILD AND QUEUES ITS OWN PROMPT, so there is
    // nothing left for this path to send. Routing it on would deliver the
    // re-dispatch text twice.
    if (envelope.approval) {
      applyAnswer(envelope.approval);

      return { ok: true, queued: 'sent' };
    }

    const prompt = {
      text: `${mountBannerPrefix()}${formatPrompt(envelope)}`,
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
    async stop(mode: 'graceful' | 'now' = 'now'): Promise<void> {
      await doStop(mode);
    },
  };
}
