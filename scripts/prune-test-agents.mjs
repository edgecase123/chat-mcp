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
 *   node scripts/prune-test-agents.mjs                      list, delete nothing
 *   node scripts/prune-test-agents.mjs perm-1-agent e2e-2   delete those two
 *   node scripts/prune-test-agents.mjs --force stuck-agent  delete even if live
 */
const { openDb } = await import('../dist/storage/db.js');
const dao = await import('../dist/storage/dao.js');

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
  console.log('\nPass handles in FULL to delete them. Prefixes are not matched.');
  process.exit(0);
}

const { prunable, online, absent } = dao.partitionPrunable(db, names);
const targets = force ? [...prunable, ...online] : prunable;
const deleted = dao.pruneAgents(db, targets);

console.log(`deleted ${deleted.length} of ${names.length}: ${deleted.join(', ') || '(none)'}`);
// Both halves are reported: a name that was not there is a typo, not a success.
if (absent.length > 0) console.log(`not registered, nothing done: ${absent.join(', ')}`);
if (online.length > 0 && !force) {
  console.log(`ONLINE, refused: ${online.join(', ')}`);
  console.log('Pass --force only if you know that process is gone.');
}

process.exit(absent.length > 0 || (online.length > 0 && !force) ? 1 : 0);
