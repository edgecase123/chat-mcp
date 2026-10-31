/**
 * The constraint this project actually runs under.
 *
 * 🛑 `total_cost_usd` IS NOT A BILL ON A SUBSCRIPTION. lee, 2026-10-16:
 * *"i have claude code pro that cost $100/month. So i get bank of use and
 * don't pay metered by token"*. So dollars are a notional figure and the real
 * currency is WINDOW UTILIZATION.
 *
 * Observed in a live run on 2026-10-16 — the CLI emits this unprompted:
 *
 *   {"type":"rate_limit_event","rate_limit_info":{
 *     "status":"allowed","rateLimitType":"five_hour",
 *     "overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
 *     "unifiedWindows":{"five_hour":{"utilization":0.52,"resetsAt":...},
 *                       "seven_day":{"utilization":0.33,"resetsAt":...}}}}
 *
 * 🚨 **`overageStatus: "rejected"` is the load-bearing field.** Overage is
 * disabled at the organisation level, so a full window REFUSES requests rather
 * than billing for them. Running out does not cost money — it stops work.
 */

export interface WindowState {
  readonly utilization: number;
  readonly resetsAt: number;
}

export interface RateLimitSnapshot {
  readonly status: string;
  readonly overageAvailable: boolean;
  readonly windows: Readonly<Record<string, WindowState>>;
  readonly observedAt: number;
}

export type GateVerdict =
  | { readonly allow: true; readonly reason: 'unknown' | 'unmetered' | 'within-budget' }
  | { readonly allow: false; readonly reason: string; readonly resetsAt?: number };

export class RateLimitGate {
  private snapshot: RateLimitSnapshot | null = null;

  /**
   * @param ceiling refuse to dispatch at or above this utilization, 0..1
   * @param metered whether the driver ever reports usage at all. When false
   *   the gate is explicitly UNMETERED and says so, instead of answering
   *   `unknown` forever — which reads as "not yet" and means "never".
   */
  constructor(
    private readonly ceiling = 0.9,
    private readonly metered = true,
  ) {}

  /** True when the driver meters but nothing has arrived yet. */
  get awaitingFirstReport(): boolean {
    return this.metered && this.snapshot === null;
  }

  /**
   * Take a NORMALISED snapshot from a driver.
   *
   * 🛑 Parsing moved into the driver on purpose. This used to accept a raw
   * event and test `type === 'rate_limit_event'`, which is Claude Code's
   * shape. A CLI reporting limits any other way could not be understood, and
   * one reporting none at all would silently look identical to one at 0%.
   */
  update(snapshot: RateLimitSnapshot): void {
    this.snapshot = snapshot;
  }

  get latest(): RateLimitSnapshot | null {
    return this.snapshot;
  }

  /**
   * 🛑 FAILS OPEN WHEN NOTHING IS KNOWN, AND SAYS SO.
   *
   * There is no rate-limit event before the first turn, so failing closed
   * would mean never dispatching at all. The verdict reports `unknown` rather
   * than `within-budget` — the caller must not be able to read "we have not
   * checked" as "we checked and it is fine", which is the green-state-nobody-
   * verified failure this project names explicitly.
   */
  verdict(): GateVerdict {
    const snap = this.snapshot;

    // 🛑 'unmetered' and 'unknown' are DIFFERENT and used to be the same
    // answer. 'unknown' is the first turn, before any report. 'unmetered' is
    // forever, and the supervisor announces it at startup.
    if (!this.metered) return { allow: true, reason: 'unmetered' };

    if (!snap) return { allow: true, reason: 'unknown' };

    if (snap.status !== 'allowed') {
      return { allow: false, reason: `the API reports status "${snap.status}"` };
    }

    for (const [name, w] of Object.entries(snap.windows)) {
      if (w.utilization >= this.ceiling) {
        return {
          allow: false,
          reason: `${name} window at ${Math.round(w.utilization * 100)}%, ceiling ${Math.round(this.ceiling * 100)}%`
            + (snap.overageAvailable ? '' : ' and overage is REJECTED, so a full window refuses requests'),
          resetsAt: w.resetsAt,
        };
      }
    }

    return { allow: true, reason: 'within-budget' };
  }

  /** One line for a human, in utilization and never in dollars. */
  describe(): string {
    const snap = this.snapshot;

    if (!this.metered) {
      return 'rate limits: UNMETERED — this driver reports none, so NOTHING bounds dispatch';
    }

    if (!snap) return 'rate limits: not yet observed';

    const parts = Object.entries(snap.windows)
      .map(([name, w]) => `${name} ${Math.round(w.utilization * 100)}%`)
      .join('  ');

    return `rate limits: ${parts || 'no windows reported'}  overage=${snap.overageAvailable ? 'available' : 'REJECTED'}`;
  }
}
