/**
 * Waiting for a fire-and-forget side effect to LAND, instead of giving it a
 * fixed budget and hoping.
 *
 * #305. `activity.test.ts` slept 120ms and then asserted an HTTP round trip
 * had completed. Under a loaded full-suite run the request was still in
 * flight, so the gate went red on working code and green on a re-run.
 *
 * 🛑 THE DEADLINE IS NOT A BIGGER SLEEP. A passing run costs one poll step
 * rather than the deadline, and a real failure still fails — by timeout,
 * naming the count it reached.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 */

/** Generous, because only a run that is going to fail ever pays it. */
const DEADLINE_MS = 5_000;

const STEP_MS = 5;

/** One full `ACTIVITY_THROTTLE_MS` window, and twice the sleep this replaced. */
const QUIET_MS = 250;

type Options = {
  /** How many must arrive. */
  want?: number;
  /** Appended to the failure, for the diagnosis the count alone cannot give. */
  label?: string;
  deadlineMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function note(label: string | undefined): string {
  return label === undefined ? "" : ` — ${label}`;
}

/**
 * Poll `count` until it reaches `want`, then return. Throws on the deadline,
 * naming how far it actually got.
 */
export async function arrived(
  count: () => number,
  options: Options = {},
): Promise<void> {
  const { want = 1, label, deadlineMs = DEADLINE_MS } = options;
  const until = Date.now() + deadlineMs;

  while (count() < want) {
    if (Date.now() >= until) {
      throw new Error(
        `only ${String(count())} of ${String(want)} arrived within ${String(deadlineMs)}ms${note(label)}`,
      );
    }

    await sleep(STEP_MS);
  }
}

/**
 * {@link arrived}, then hold still and require the count has not grown. Use it
 * wherever the test's claim is an EXACT count.
 *
 * 🛑 THIS IS THE ONE A BARE POLL CANNOT REPLACE. "Exactly one post" is an
 * upper bound, and a poll returning on the FIRST arrival meets it while
 * nineteen more are in flight — so `arrived` alone would green a reporter that
 * posts every event.
 */
export async function arrivedAndStayed(
  count: () => number,
  options: Options & { quietMs?: number } = {},
): Promise<void> {
  const { want = 1, label, quietMs = QUIET_MS } = options;

  await arrived(count, options);
  await sleep(quietMs);

  if (count() !== want) {
    throw new Error(
      `${String(count())} arrived where ${String(want)} was the whole budget, within ${String(quietMs)}ms of the first${note(label)}`,
    );
  }
}
