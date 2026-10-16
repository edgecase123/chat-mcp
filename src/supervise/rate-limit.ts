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
  | { readonly allow: true; readonly reason: 'unknown' | 'within-budget' }
  | { readonly allow: false; readonly reason: string; readonly resetsAt?: number };

/** Pull a snapshot out of a raw stream-json event, or null if it is not one. */
export function parseRateLimitEvent(event: Record<string, unknown>): RateLimitSnapshot | null {
  if (event.type !== 'rate_limit_event') return null;

  const info = event.rate_limit_info as Record<string, unknown> | undefined;

  if (!info || typeof info !== 'object') return null;

  const raw = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>;
  const windows: Record<string, WindowState> = {};

  for (const [name, w] of Object.entries(raw)) {
    if (typeof w?.utilization === 'number') {
      windows[name] = {
        utilization: w.utilization,
        resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : 0,
      };
    }
  }

  return {
    status: typeof info.status === 'string' ? info.status : 'unknown',
    // Absent means we do not know, and we must not assume overage exists.
    overageAvailable: info.overageStatus === 'allowed',
    windows,
    observedAt: Date.now(),
  };
}

export class RateLimitGate {
  private snapshot: RateLimitSnapshot | null = null;

  /**
   * @param ceiling refuse to dispatch at or above this utilization, 0..1
   */
  constructor(private readonly ceiling = 0.9) {}

  observe(event: Record<string, unknown>): RateLimitSnapshot | null {
    const parsed = parseRateLimitEvent(event);

    if (parsed) this.snapshot = parsed;

    return parsed;
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

    if (!snap) return 'rate limits: not yet observed';

    const parts = Object.entries(snap.windows)
      .map(([name, w]) => `${name} ${Math.round(w.utilization * 100)}%`)
      .join('  ');

    return `rate limits: ${parts || 'no windows reported'}  overage=${snap.overageAvailable ? 'available' : 'REJECTED'}`;
  }
}
