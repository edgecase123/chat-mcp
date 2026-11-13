import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { manifestDir, stateDir } from '../util/paths.js';

/**
 * Is a path inside a directory, after symlinks?
 *
 * 🛑 `realpathSync`, NOT `resolve`. `resolve` is LEXICAL and a symlink inside
 * an allowed directory escapes it. Measured by claude1 on the working-directory
 * path, and again on a manifest script path:
 *
 *   ln -s /bin/sh proj/scripts/go.sh
 *   a lexical check reads "scripts/go.sh" as contained; it runs /bin/sh
 */

/**
 * A manifest script path that has been checked LEXICALLY and nothing more.
 *
 * 🛑 NOT A STRING, DELIBERATELY. The lexical check cannot see a symlink, so
 * the only safe use is `checkedScriptPath`. Making this an object means
 * handing it to `execFile` is a compile error rather than a missing call.
 */
export interface UncheckedScript {
  /** Relative to the project directory, normalised, lexically contained. */
  readonly relative: string;
}

/**
 * Does `dir` contain `target`, comparing REAL paths?
 *
 * A `dir` that is not on disk contains nothing — an absent allowed directory
 * must not accidentally contain everything.
 */
export function realContains(dir: string, target: string): boolean {
  let base: string;
  let real: string;

  try {
    base = realpathSync(resolve(dir));
  } catch {
    return false;
  }

  try {
    real = realpathSync(resolve(target));
  } catch {
    // Compare what the caller named. A missing target is not contained, and
    // the caller distinguishes "missing" from "outside" by its own check.
    real = resolve(target);
  }

  return real === base || real.startsWith(`${base}/`);
}

/**
 * The real path a path WILL have once it exists, resolved through its deepest
 * existing ancestor.
 *
 * 🛑 `realContains` SKIPS realpath ON A MISSING TARGET, so a path that does not
 * exist yet under a SYMLINKED ancestor reads as outside the directory that will
 * hold it. Measured: `manifestDir()` is created on demand by
 * `ensureManifestDir`, and on macOS `/var` is a symlink to `/private/var`:
 *
 *   base   realpath(/var/folders/../parent)  -> /private/var/folders/../parent
 *   target /var/folders/../parent/x-manifests   (absent, so NOT realpathed)
 *   startsWith -> false, and the mount would have carried it in
 */
function realPathWhenCreated(target: string): string {
  let current = resolve(target);
  const tail: string[] = [];

  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);

      // `dirname('/') === '/'`, so this is the root and nothing resolved.
      if (parent === current) return resolve(target);

      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * `realContains`, for two paths that may not exist YET.
 *
 * 🛑 NOT `realContains`. It returns false on a base that is not on disk —
 * deliberate there, so an absent allowed directory contains nothing — but here
 * the base is a project tree Docker CREATES as the bind source, and
 * `ensureStateDir` then fills the sandbox in underneath it.
 */
function containsWhenCreated(dir: string, target: string): boolean {
  const base = realPathWhenCreated(dir);
  const real = realPathWhenCreated(target);

  return real === base || real.startsWith(`${base}/`);
}

/**
 * Refuse a project directory that OVERLAPS the sandbox's own state, or throw.
 *
 * 🛑 OVERLAP IS TWO-DIRECTIONAL AND ONLY ONE HALF IS OBVIOUS. An ANCESTOR
 * carries the state in under the project mount. A DESCENDANT is the same hole
 * through the other door: `<state>/tokens` is neither equal to nor an ancestor
 * of `<state>`, so a one-way check allows it and it lands at `/work`
 * read-write. `authenticateToken` then trusts the digest written there, which
 * is the forgery #188 describes. Both directions have a test.
 *
 * 🛑 THE STATE-DIR CHECK ONLY BECAME A BARRIER RECENTLY. `stateDir()` was
 * bind-mounted read-write on every containerized spawn, so this changed nothing
 * the container could already reach. That mount is gone, so the project mount
 * is the only remaining route in. `manifestDir()` was always the live half,
 * because it is bind-mounted nowhere and the broker executes from it.
 *
 * 🛑 BOTH PATHS ARE STILL NEEDED, AND A SYMLINK IS WHAT SEPARATES THEM.
 * `manifestDir()` is `${stateDir()}-manifests`, a sibling, so an ancestor of
 * one is normally an ancestor of the other — until `stateDir()` resolves away:
 *
 *   CHAT_MCP_HOME=/a/b/state -> /x/y/real   /a/b does NOT contain it
 *   manifestDir()             = /a/b/state-manifests    /a/b DOES
 *
 * ⚠️ REFUSING, NOT EXCLUDING. A nested `:ro` mount over the sensitive paths
 * still DISCLOSES `chat.db` — every room and DM — which is #162.
 */
export function assertProjectDirOutsideState(projectDir: string): void {
  assertDisjoint(
    projectDir,
    stateDir(),
    'state directory',
    'mounting it would put the sandbox inside the container read-write',
  );

  assertDisjoint(
    projectDir,
    manifestDir(),
    'manifest directory',
    'the agent could edit the manifest the broker executes from',
  );
}

/** Neither path may contain the other. */
function assertDisjoint(projectDir: string, sensitive: string, noun: string, why: string): void {
  const overlap = containsWhenCreated(projectDir, sensitive)
    ? 'contains'
    : containsWhenCreated(sensitive, projectDir)
      ? 'is inside'
      : null;

  if (overlap !== null) {
    throw new Error(`refusing "${projectDir}": it ${overlap} the ${noun} "${sensitive}", so ${why}`);
  }
}

export function assertNoControlChars(raw: string, noun: string): void {
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error(`${noun} has a control character in it: "${raw}"`);
  }
}

/**
 * Refuse a relative path that is absolute, control-charactered, or that
 * LEXICALLY leaves the project. Returns the normalised form.
 *
 * 🛑 LEXICAL ONLY, SO IT IS NOT CONTAINMENT. It exists for the one caller that
 * has no project directory to resolve against — manifest PARSE time, where
 * there is no file on disk either. Anything that then acts on the path goes
 * through `checkedProjectPath`.
 */
export function containedRelative(raw: unknown, noun: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${noun} must be a non-empty string`);
  }

  if (isAbsolute(raw)) {
    throw new Error(`${noun} must be a relative path, got "${raw}"`);
  }

  assertNoControlChars(raw, noun);

  const normalised = normalize(raw);
  // 🛑 SEGMENTS, NOT `startsWith('../')`. On win32 `normalize` returns
  // `..\bin\sh`, which a forward-slash prefix check reads as contained. A
  // filename that merely BEGINS with dots, like `..foo`, is legitimate.
  const segments = normalised.split(/[\\/]/);

  if (segments[0] === '..') {
    throw new Error(`${noun} must stay inside the project, got "${raw}"`);
  }

  if (segments.some((segment) => segment.startsWith('-'))) {
    throw new Error(`${noun} must not have a path segment starting with "-", got "${raw}"`);
  }

  // 🛑 A COLON IS A FIELD DELIMITER IN A DOCKER `-v` SPEC, and a legal POSIX
  // filename character. `odd:name` builds a four-field spec that the daemon
  // refuses, so one bad entry denies the whole spawn.
  if (normalised.includes(':')) {
    throw new Error(`${noun} must not contain a colon, got "${raw}"`);
  }

  return normalised;
}

/**
 * The absolute path a project-relative entry actually resolves to, or throw.
 *
 * ⚠️ MISSING AND OUTSIDE ARE DIFFERENT ERRORS. Reporting a typo'd path as a
 * containment refusal sends the operator hunting a permissions problem that
 * does not exist — the same distinction `resolveCwd` makes. `noun` is what the
 * caller is checking, so neither message is script-specific.
 */
export function checkedProjectPath(projectDir: string, relative: string, noun: string): string {
  const target = join(projectDir, containedRelative(relative, noun));
  let real: string;

  try {
    real = realpathSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${noun} does not exist: ${target}`);
    }

    throw err;
  }

  if (!realContains(projectDir, real)) {
    throw new Error(
      `refusing "${relative}": it resolves to "${real}", which is outside ` +
        `the project directory "${projectDir}"`,
    );
  }

  return real;
}

/** A declared path resolved to the one host directory it may be mounted from. */
export interface MountPath {
  /** The host side of the bind mount, after symlinks. */
  readonly host: string;
  /** Where it goes under the project mount. Normalised, no trailing slash. */
  readonly inner: string;
}

/**
 * Resolve a project-declared path into a bind mount, or throw.
 *
 * 🛑 THE DECLARED PATH MUST BE ITS OWN REAL PATH. A symlink gives the same host
 * directory TWO names under the project mount, and a read-only mount covers
 * only the name it is mounted at:
 *
 *   proj/scripts -> real-scripts        contained, so a realpath check passes
 *   -v <proj>/real-scripts:/work/scripts:ro
 *   /work/real-scripts                  STILL WRITABLE, same host directory
 *
 * The broker resolves `scripts/gate.sh` through the symlink too, so the agent
 * writes the file the broker runs. Refusing is what makes the mount hold
 * ACROSS spawns: once the path is a real directory and mounted, the kernel
 * refuses to unlink, rename or re-point the mountpoint — measured, so the agent
 * cannot turn it into a symlink later either.
 *
 * ⚠️ REFUSING, NOT REMAPPING. Mounting at the resolved name instead would
 * protect the right directory this spawn, and leave the symlink itself
 * writable — so the next spawn resolves through whatever the agent re-pointed
 * it at.
 */
export function checkedMountPath(projectDir: string, declared: string, noun: string): MountPath {
  const inner = containedRelative(declared, noun).replace(/\/+$/, '');

  // `.`, `./` and `scripts/..` all normalise to the root, which would mount the
  // whole project read-only and stop the agent editing the repo it works in.
  if (inner === '' || inner === '.') {
    throw new Error(`${noun} may not be the project root, got "${declared}"`);
  }

  let realProject: string;

  try {
    realProject = realpathSync(projectDir);
  } catch {
    throw new Error(`the project directory does not exist: ${projectDir}`);
  }

  const host = checkedProjectPath(realProject, inner, noun);

  if (host !== join(realProject, inner)) {
    throw new Error(
      `refusing "${declared}": it is a symlink or sits under one, resolving to "${host}". ` +
        'A read-only mount would leave that directory writable under its real name.',
    );
  }

  return { host, inner };
}

/** The absolute path a manifest's script actually runs, or throw. */
export function checkedScriptPath(projectDir: string, script: UncheckedScript): string {
  return checkedProjectPath(projectDir, script.relative, 'command script');
}
