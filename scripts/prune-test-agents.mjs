#!/usr/bin/env node
/**
 * List the agents registered on the bus, or delete the ones you name.
 *
 * 🛑 FULL NAMES ONLY, NEVER A PREFIX, AND IT REFUSES AN ONLINE HANDLE. Both
 * guards exist for the same hazard: freeing a live agent's handle lets another
 * process claim it, and `inbox` marks messages read — so one of the two would
 * silently consume the other's mail. `--force` overrides the liveness guard
 * and nothing overrides the prefix one.
 *
 * 🛑 IT ALSO REMOVES THE HANDLE'S NOTIFY FILE, which nothing else did outside
 * a clean session close — so one crashed run left a file behind forever (#78).
 * Removing a LIVE handle's file is silent: `fs.watch` on a removed path stops
 * delivering and reports nothing, so the same liveness refusal covers it.
 *
 * 🛑 A FILE WITH NO `agents` ROW IS REMOVABLE AND SAYS SO. All of #78's litter
 * is that shape, and no cheap liveness check reaches it, so the script states
 * that it could not check rather than implying it did.
 *
 *   node scripts/prune-test-agents.mjs                      list, delete nothing
 *   node scripts/prune-test-agents.mjs perm-1-agent e2e-2   delete those two
 *   node scripts/prune-test-agents.mjs --force stuck-agent  delete even if live
 */
const { openDb } = await import('../dist/storage/db.js');
const dao = await import('../dist/storage/dao.js');
const { notifyDir, notifyPathFor } = await import('../dist/util/paths.js');
const { partitionNotifyFiles, planNotifyRemoval } = await import('../dist/util/notify-orphans.js');
const { readdirSync, unlinkSync, existsSync } = await import('node:fs');

/** Everything in the notify directory, or nothing if it has never been made. */
const notifyFiles = () => (existsSync(notifyDir()) ? readdirSync(notifyDir()) : []);

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const names = argv.filter((a) => !a.startsWith('-'));
const db = openDb();

if (names.length === 0) {
  const agents = dao.listAgents(db, true);
  console.log(`${agents.length} agent(s) registered:\n`);
  for (const a of agents) {
    console.log(`  ${a.online ? 'online ' : 'offline'}  ${a.handle}  pid ${a.pid}`);
  }

  // 🛑 BOTH TOTALS, NEVER THE ORPHAN COUNT ALONE. #78's figure is "49 of 53",
  // and the 53 is what makes the 49 mean anything.
  const notify = partitionNotifyFiles(notifyFiles(), agents.map((a) => a.handle));
  console.log(`\n${notify.orphans.length} of ${notify.total} notify file(s) have no agent row:\n`);
  if (notify.orphans.length > 0) {
    console.log(`  ${notify.orphans.join(' ')}`);
    console.log('\nThose handles are gone, so there is no liveness to check. Remove the files with:');
    console.log(`\n  node scripts/prune-test-agents.mjs ${notify.orphans.join(' ')}`);
  }

  console.log('\nPass handles in FULL to delete them. Prefixes are not matched.');
  process.exit(0);
}

const { prunable, online, absent } = dao.partitionPrunable(db, names);
const targets = force ? [...prunable, ...online] : prunable;
const deleted = dao.pruneAgents(db, targets);

console.log(`deleted ${deleted.length} of ${names.length} agent row(s): ${deleted.join(', ') || '(none)'}`);

// 🛑 THE FILES ARE A SEPARATE LEDGER, because a name can have a row and no
// file, a file and no row, or neither. Reporting them together would let one
// half's success hide the other's refusal.
const plan = planNotifyRemoval({
  names,
  files: notifyFiles(),
  registered: dao.listAgents(db, true).map((a) => a.handle).concat(deleted),
  online,
  force,
});

const unlinked = [];
for (const step of plan) {
  if (!step.unlink) continue;
  unlinkSync(notifyPathFor(step.handle));
  unlinked.push(step.handle);
}

console.log(`removed ${unlinked.length} notify file(s): ${unlinked.join(', ') || '(none)'}`);
for (const step of plan) {
  if (step.reason === 'orphan-liveness-unchecked') {
    console.log(`  ${step.handle}: no agent row, so LIVENESS WAS NOT CHECKED. If a bus is still running under that handle, its wake is now dead.`);
  }
  if (step.reason === 'unsafe-name') {
    console.log(`  ${step.handle}: REFUSED, a handle is one path segment. --force does not override this.`);
  }
}

// Both halves are reported: a name that was not there is a typo, not a success.
if (absent.length > 0) console.log(`no agent row — see the notify-file line above for what happened to each: ${absent.join(', ')}`);
if (online.length > 0 && !force) {
  console.log(`ONLINE, refused (row and file both kept): ${online.join(', ')}`);
  console.log('Pass --force only if you know that process is gone.');
}

const refusedUnsafe = plan.some((p) => p.reason === 'unsafe-name');
const nothingDone = plan.every((p) => !p.unlink) && deleted.length === 0;

process.exit(refusedUnsafe || nothingDone || (online.length > 0 && !force) ? 1 : 0);
