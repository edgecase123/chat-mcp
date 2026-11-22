/**
 * Whether a pid names a running process.
 *
 * EPERM means it exists and belongs to another user, which is still alive.
 * ⚠️ Pid numbers are REUSED, so a long-dead incumbent can read as live. That
 * is why claiming a handle has a `force` escape hatch.
 *
 * 🛑 IT LIVES HERE RATHER THAN IN `storage/dao.ts` BECAUSE IT TOUCHES NO
 * DATABASE. `dao.ts` imports `db.ts`, which loads the native sqlite binding,
 * and `supervise/container.ts` needs this answer while importing neither.
 */
export function isProcessAlive(pid: number | null): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}
