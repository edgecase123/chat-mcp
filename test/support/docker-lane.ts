/**
 * Whether the docker lane runs here, and why not when it does not.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 *
 * 🛑 THE DOCKER LANE IS LOCAL-ONLY, BY lee's RULING OF 2026-11-11. A test that
 * starts a real container pulls an image inside its own startup budget, and a
 * runner slow enough to miss that budget reds `main` with no defect behind it
 * (#150). CI is not where that belongs.
 */

/** Only the variables the lane decision reads. */
export interface DockerLaneEnv {
  /** Set by every CI provider. Its presence is the whole signal. */
  readonly CI?: string;
  /** Escape hatch: forces the lane on where it would otherwise be skipped. */
  readonly DOCKER_TESTS?: string;
}

/** A var set to an empty string or `0` counts as unset. */
function enabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0';
}

/**
 * The reason to skip, or `false` to run.
 *
 * ⚠️ THE LANE CHECK COMES FIRST, AND IT IS PURE ENV. `dockerPresent` shells
 * out to `docker version`, which costs time on a runner and can fail there for
 * its own reasons. A lane CI never runs must not probe for a daemon CI never
 * uses.
 *
 * ⚠️ FORCING OVERRIDES THE LANE, NEVER THE ABSENCE. `DOCKER_TESTS=1` on a
 * machine with no daemon still skips, because the alternative is a confusing
 * `container never started` in place of "docker is missing".
 */
export function dockerLaneSkip(
  env: DockerLaneEnv,
  dockerPresent: () => boolean,
): string | false {
  if (enabled(env.CI) && !enabled(env.DOCKER_TESTS)) {
    return 'the docker lane is local-only (#150); run `npm run test:docker`, or set DOCKER_TESTS=1';
  }

  if (!dockerPresent()) return 'docker is not available here';

  return false;
}
