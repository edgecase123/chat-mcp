import { isProcessAlive } from '../../src/storage/dao.js';

/**
 * A pid that really is not running, found rather than assumed.
 *
 * 🛑 DO NOT HARDCODE ONE. `pid: 2` was used as "dead" and it is `kthreadd` on
 * Linux, owned by root — `isProcessAlive` treats `EPERM` as alive on purpose,
 * so the fixture inverted. It passed on macOS and reddened main in CI.
 *
 * Callers should still assert the premise, so a platform where this scan finds
 * nothing useful fails loudly rather than inverting an expectation.
 */
export function deadPid(): number {
  // Above Linux's default pid_max of 4194304, so it cannot be allocated.
  for (let pid = 4_194_305; pid < 4_194_405; pid += 1) {
    if (!isProcessAlive(pid)) return pid;
  }

  throw new Error('no dead pid found above the usual pid_max — widen the scan');
}
