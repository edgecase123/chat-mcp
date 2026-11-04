/**
 * Which notify files belong to a handle the bus still knows about, and which
 * of them an operator may remove.
 *
 * 🛑 REMOVING A LIVE HANDLE'S NOTIFY FILE IS SILENT. `fs.watch` on a removed
 * path stops delivering and reports nothing, which is why the wake Monitor
 * watches the DIRECTORY rather than the file. So a removal that is wrong
 * about liveness does not crash — it produces an agent that looks idle
 * forever (#78).
 *
 * 🛑 EVERY DECISION LIVES HERE, WHERE IT CAN BE TESTED WITHOUT A FILESYSTEM.
 * The caller does the `unlinkSync` and nothing else. A plan that is wrong is
 * then a failing test rather than a quiet agent.
 *
 * 🛑 AND THE OPERATOR DECIDES, NOT A SWEEP. lee's ruling on #78's open
 * question is the shape of this module: there is no automatic deletion, no
 * age heuristic and no prefix match. A file goes only when a human names it
 * in full.
 */

/** A file is created per handle and holds that handle's DMs and every room. */
export interface NotifyPartition {
  /** Files whose handle still has an `agents` row. */
  readonly attached: readonly string[];
  /** Files whose handle has no `agents` row. Sorted, so they paste back. */
  readonly orphans: readonly string[];
  /** Every file seen. */
  readonly total: number;
  /** Every handle the bus knows, whether or not it has a file. */
  readonly registered: number;
}

/**
 * Split the notify directory against the `agents` table.
 *
 * ⚠️ IT REPORTS BOTH TOTALS. #78's own figure is "49 of 53", and a function
 * returning only the orphan list invites the 49 being quoted with no 53
 * beside it.
 */
export function partitionNotifyFiles(
  files: readonly string[],
  registeredHandles: readonly string[],
): NotifyPartition {
  const known = new Set(registeredHandles);
  const attached: string[] = [];
  const orphans: string[] = [];

  for (const file of files) {
    if (known.has(file)) attached.push(file);
    else orphans.push(file);
  }

  return {
    attached: attached.sort(),
    orphans: orphans.sort(),
    total: files.length,
    registered: known.size,
  };
}

/**
 * 🛑 A HANDLE IS A SINGLE PATH SEGMENT, AND THE NAMES COME FROM argv.
 *
 * `notifyPathFor` joins the name straight onto the notify directory, so
 * `../chat.db` would resolve outside it and this module's caller unlinks what
 * it is given. The orphan list itself comes from `readdir` and is safe; a
 * typed name is not.
 */
export function isSafeHandleName(name: string): boolean {
  if (name.length === 0) return false;
  if (name === '.' || name === '..') return false;

  return !/[/\\]/.test(name);
}

/**
 * What an operator is told about an orphan, in both list mode and after a
 * removal.
 *
 * 🛑 ONE COPY, AND IT MUST NOT CLAIM LIVENESS. The first version of list mode
 * said *"those handles are gone, so there is no liveness to check"* — which IS
 * the liveness claim this whole module refuses to make, printed in the one
 * place a human reads BEFORE deciding to delete. The removal path said
 * "LIVENESS WAS NOT CHECKED" four lines later and the two contradicted.
 * claude1 caught it on PR 114.
 *
 * ⚠️ `UNCHECKED` is the SAME SENTENCE both paths print, so they cannot drift
 * again.
 */
export const ORPHAN_UNCHECKED =
  'no agent row. That is NOT proof no bus is running under that handle — nothing here can check. ' +
  'If one is, removing its file kills its wake silently.';

export type RemovalReason =
  /** Registered, offline — the row and the file go together. */
  | 'offline-row'
  /** Registered and online, removed anyway because `--force` was given. */
  | 'forced'
  /** No row at all, so liveness could not be checked. Said, not implied. */
  | 'orphan-liveness-unchecked'
  /** Registered and online. Removing the file would silence the agent. */
  | 'online'
  /** Named, but there is no such file. A typo, not a success. */
  | 'no-file'
  /** Could escape the notify directory. No override. */
  | 'unsafe-name';

export interface NotifyRemoval {
  readonly handle: string;
  readonly unlink: boolean;
  readonly reason: RemovalReason;
}

export interface RemovalRequest {
  /** Handles the operator named, in full. Order is preserved in the plan. */
  readonly names: readonly string[];
  /** Everything in the notify directory. */
  readonly files: readonly string[];
  /** Every handle with an `agents` row. */
  readonly registered: readonly string[];
  /** The subset of `registered` whose process is live. */
  readonly online: readonly string[];
  /** Overrides the liveness refusal. Never the unsafe-name refusal. */
  readonly force: boolean;
}

/**
 * Decide, per named handle, whether its notify file may be removed.
 *
 * 🛑 THE ORPHAN PATH EXISTS BECAUSE #78's OWN `## Proposed` COULD NOT REACH
 * THE LITTER IT MEASURED. It proposed removing the file "alongside its
 * `agents` row", and all 49 orphans have no row — `partitionPrunable` calls
 * them `absent` and does nothing. So an orphan is removable on the operator's
 * word, and its reason records that liveness was never checked.
 */
export function planNotifyRemoval(request: RemovalRequest): NotifyRemoval[] {
  const files = new Set(request.files);
  const registered = new Set(request.registered);
  const online = new Set(request.online);

  return request.names.map((handle) => {
    // 🛑 FIRST, AND BEFORE `force`. A name that can escape the directory is
    // refused whatever else is true of it, which is the same split the prune
    // script already draws: the liveness guard has an override, the
    // structural one does not.
    if (!isSafeHandleName(handle)) return { handle, unlink: false, reason: 'unsafe-name' };

    if (!files.has(handle)) return { handle, unlink: false, reason: 'no-file' };

    if (!registered.has(handle)) {
      return { handle, unlink: true, reason: 'orphan-liveness-unchecked' };
    }

    if (online.has(handle)) {
      return request.force
        ? { handle, unlink: true, reason: 'forced' }
        : { handle, unlink: false, reason: 'online' };
    }

    return { handle, unlink: true, reason: 'offline-row' };
  });
}
