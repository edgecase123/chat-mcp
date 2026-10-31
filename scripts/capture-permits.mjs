#!/usr/bin/env node
/**
 * Record what a grant actually DOES, which is the half the corpus lacks.
 *
 * 🛑 A REFUSAL IS FREE AND A PERMIT IS NOT. A refusal is filed the moment the
 * child is denied. A permit needs the approval answered and the agent given
 * another turn, and until now the only way to answer one was a browser click.
 * `answerAndNotify` made it scriptable.
 *
 * 🛑 THIS DOES NOT MAKE THE PRODUCT AUTO-APPROVE. lee's ruling stands: manual
 * is the default permission mode. This harness supplies its own decision
 * because it is recording an OUTCOME, not testing the approval surface —
 * `supervise-e2e.mjs` is what proves a human can approve, and it still needs
 * a real click.
 *
 * ⚠️ IT SPENDS MONEY. Opt in with CHAT_MCP_LIVE=1.
 *
 *   CHAT_MCP_LIVE=1 node --import tsx scripts/capture-permits.mjs
 *
 * 🛑 ONE PROBE PER SUPERVISOR, ON PURPOSE. Running them together lets one
 * probe's grant widen the allowlist the next one is measured under, and a
 * two-variable run is how three wrong conclusions were drawn in one evening.
 */

import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../src/supervise/index.ts';
import { deliverToSupervisor } from '../src/supervise/socket.ts';
import { answerAndNotify } from '../src/supervise/answer.ts';
import { openDb } from '../src/storage/db.ts';
import * as dao from '../src/storage/dao.ts';

// 🛑 `--list` IS THE ONLY FREE WAY TO SEE WHAT THIS RUN WOULD MEASURE.
// The loop derives its indices from the probe list, and nothing else can show
// that the two agree without spawning an agent and spending money.
const LIST_ONLY = process.argv.includes('--list');

if (!LIST_ONLY && !process.env.CHAT_MCP_LIVE) {
  console.error('Refusing to run: this spawns a real agent CLI and spends money.');
  console.error('Set CHAT_MCP_LIVE=1 to opt in.');
  process.exit(2);
}

// ⚠️ RESOLVED FROM THIS MODULE, NOT THE CWD. `would-refuse.ts` carries the
// same note for the same reason: a relative path only works when the run
// happens to start at the package root. Both writes below were relative.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASE_ALLOWLIST = ['Read', 'Glob', 'Grep', 'mcp__chat__send', 'mcp__chat__room_send'];
const SETTLE_MS = Number(process.env.PERMIT_SETTLE_SECONDS ?? 90) * 1000;
const db = openDb();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🛑 ONE READER FOR BOTH TAG PROBES. Copying the seven lines is the
// one-fix-two-sites shape that landed three times in one day: a later fix to
// the swallowed-error branch would reach one probe and not the other.
function hasTag(work, name) {
  try {
    return execFileSync('git', ['-C', work, 'tag', '-l', name]).toString().includes(name);
  } catch {
    return false;
  }
}

/**
 * Every probe needs an OBSERVABLE target.
 *
 * 🛑 ASKING THE AGENT WHETHER IT WORKED ASKS THE THING UNDER TEST. `env` was
 * in the refusal harness and is useless here: it changes nothing anyone can
 * look at afterwards.
 */
function probesFor(root, work, handle) {
  const made = join(work, 'made.txt');
  const tag = `permit-${process.pid}`;
  const cdTag = `permit-cd-${process.pid}`;
  const sentinel = `permit-ok-${process.pid}`;
  const firstHalf = join(work, 'compound-a.txt');
  const secondHalf = join(work, 'compound-b.txt');

  // ⚠️ `probesFor('', '', 'x')` builds the ROSTER with dummy arguments, and
  // `realpathSync('')` throws. The roster only needs labels.
  const symlinked = join(work, 'canonical.txt');
  const realpath = work ? join(realpathSync(work), 'canonical.txt') : symlinked;

  return [
    {
      /**
       * 🛑 THE PROBE THAT CHECKS A CLAIM I MADE AND BUILT ON. After run 8 I
       * concluded `rm` cannot be granted by any allowlist entry, and the e2e
       * task was changed away from the filesystem because of it. Run 8
       * predates BOTH the path-spelling fix (6cca826) and the prose fix
       * (468f5dc), so the grant it was refused under was malformed.
       *
       * `touch` was measured as grantable here, which already contradicts
       * the general form of that claim.
       */
      label: 'remove a file inside the allowed directory',
      command: `rm ${join(work, 'README.md')}`,
      moved: () => !existsSync(join(work, 'README.md')),
    },
    {
      label: 'touch a file inside the allowed directory',
      command: `touch ${made}`,
      moved: () => existsSync(made),
    },
    {
      label: 'create a git tag in the scratch repo',
      command: `git -C ${work} tag ${tag}`,
      moved: () => hasTag(work, tag),
    },
    {
      label: 'publish a status over MCP',
      command: `mcp__chat__set_status with status "tool" and focus exactly "${sentinel}"`,
      moved: () => {
        const a = dao.getAgent(db, `${handle}-agent`);

        return `${a?.focus ?? ''} ${a?.status ?? ''}`.includes(sentinel);
      },
    },
    {
      /**
       * 🛑 THE `cd && git` GATE CLASS, WHICH NOTHING HAS EVER REACHED.
       * Approval 43 granted `git -C <work> tag <name>` and the tag resolved,
       * so the git half is measured. It carried no `cd`, so it says nothing
       * about the guard that fires when a command changes directory first.
       *
       * Same observable target as probe 3 ON PURPOSE. The tag either resolves
       * or it does not, and `cd` is then the only variable between them.
       */
      label: 'change directory and then create a git tag',
      command: `cd ${work} && git tag ${cdTag}`,
      moved: () => hasTag(work, cdTag),
    },
    {
      /**
       * 🛑 THE MULTIPLE-OPERATIONS GATE CLASS. The corpus holds a
       * compound REFUSAL and no compound permit, so `c12c81d` is recorded as
       * a defect and the shape is unmeasured under a well-formed grant.
       *
       * Both halves are `touch`, which approval 42 already measured as
       * grantable on its own. The separator is therefore the only variable.
       */
      label: 'two operations in one command, separated by a semicolon',
      command: `touch ${firstHalf}; touch ${secondHalf}`,
      moved: () => existsSync(firstHalf) && existsSync(secondHalf),
      /**
       * ⚠️ A HALF-RUN COMPOUND IS NOT A REFUSED COMPOUND, and `moved: false`
       * alone cannot tell them apart. Six of six defects were "the string we
       * sent was wrong", so the run must say which halves landed.
       */
      note: () =>
        `halves present: a=${existsSync(firstHalf)} b=${existsSync(secondHalf)}`,
    },
    {
      /**
       * 🛑 DOES THE CLI CANONICALISE A PATH BEFORE MATCHING IT?
       *
       * Every path-bearing permit in the corpus names a spelling the child
       * never typed — 6 of 6, measured 2026-10-31. It is structural:
       * `grantFor()` canonicalises, and a probe's path comes from
       * `mkdtempSync`, which returns the `/var` symlink. So the pair can
       * never agree and no re-run of the other probes can settle it.
       *
       * If the CLI canonicalises, the stored entry IS the one that matched
       * and all six records are sound. If it matches the string as typed,
       * they name the wrong entry. Nothing measured so far separates those.
       *
       * 🛑 SO THIS PROBE IS PRE-GRANTED, AND ONLY WITH THE REALPATH FORM.
       * The command names the symlink. One variable.
       *
       * ⚠️ IT DOES NOT GO THROUGH `applyAnswer`. A pre-granted probe is never
       * denied, so the relay is not exercised and this measures the CLI's
       * matching alone. That is the right trade for this question and it must
       * not be read later as proof the relay works for a single-form grant.
       * claude1's caveat, and the evidence string carries it.
       */
      label: 'the grant names the realpath and the command names the symlink',
      command: `touch ${symlinked}`,
      preGranted: `Bash(touch ${realpath})`,
      caveat:
        'PRE-GRANTED, so no approval occurred and `applyAnswer` was never reached. ' +
        'It measures the CLI\'s path matching, NOT the relay.',
      moved: () => existsSync(symlinked),
    },
  ];
}

const captured = [];

/**
 * 🛑 EVERY PROBE'S OUTCOME, INCLUDING THE ONES THAT BOUGHT NO PERMIT.
 *
 * `captured` holds permits only, so an APPROVED grant whose target did not
 * move used to exist in console scrollback and nowhere else. That is the
 * measurement #42 is for — a refusal that survived a well-formed grant — and
 * it was the row the harness discarded. claude1 found it on this PR.
 *
 * 🛑 NOT A CORPUS RECORD, AND NOT UNDER `test/fixtures/`. Writing one would
 * need a third outcome alongside `refused` and `permitted`, and filing it as
 * `refused` would make `classify()` answer `refused` for a command under a
 * grant. That shape is lee's call, so this file only preserves the evidence
 * until the ruling lands. Nothing reads it.
 */
const observations = [];

// 🛑 A PERMIT THE HARNESS REFUSED TO CLAIM IS NOT A FAILED PROBE, and the
// summary has to say which it was. Both exit 1, and only one of them means
// the command did not work.
const withheld = [];

/**
 * 🛑 APPROVED, AND THE TARGET DID NOT MOVE. lee ruled on 2026-10-31 that
 * this gets its own corpus outcome, so it is no longer observation-only.
 *
 * 🛑 IT IS NOT A REFUSAL. The child was ALLOWED. Filing it as `refused`
 * would make `classify()` answer "no, not under that grant" to a question
 * whose measured answer is "yes, and it did nothing".
 */
const underGrant = [];

const PROBE_LABELS = probesFor('', '', 'x').map((p) => p.label);

if (LIST_ONLY) {
  // 🛑 THE ALLOWLIST SIZE IS PART OF THE ROSTER. A probe measured under a
  // different starting set is a different experiment, and a roster that hides
  // that reads as seven runs of one setup.
  for (const [i, probe] of probesFor('', '', 'x').entries()) {
    const size = (probe.preGranted ? [...BASE_ALLOWLIST, probe.preGranted] : BASE_ALLOWLIST).length;

    console.log(`${i + 1}. ${probe.label}`);
    console.log(`   starts with ${size} allowed tool(s)${probe.preGranted ? ', PRE-GRANTED' : ''}`);
  }

  console.log(`\n${PROBE_LABELS.length} probe(s), and the run iterates every one of them.`);
  process.exit(0);
}

// 🛑 DERIVED, NEVER A LITERAL. A hardcoded [0, 1, 2, 3] leaves a fifth probe
// unrun, and the run then prints `NO PERMIT` for it. That reads as a measured
// refusal when nothing was attempted at all.
for (const index of PROBE_LABELS.keys()) {
  const handle = `perm-${process.pid}-${index}`;
  const root = mkdtempSync(join(tmpdir(), 'chat-mcp-e2e-'));
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'README.md'), 'permit\n', 'utf8');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 'p@example.com']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 'p']);
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', 'initial']);

  const probes = probesFor(root, work, handle);

  // ⚠️ TWO CALLS, ONE ASSUMED LENGTH. `PROBE_LABELS` is built from a
  // throwaway call with dummy arguments. Nothing makes the roster depend on
  // those arguments today, and nothing stops it either. claude1 on this PR.
  if (probes.length !== PROBE_LABELS.length) {
    throw new Error(`roster is ${PROBE_LABELS.length} probe(s), this call built ${probes.length}`);
  }

  const probe = probes[index];

  console.log(`\n── probe ${index + 1}: ${probe.label}`);
  console.log(`   ${probe.command}`);

  // 🛑 THE STARTING SET IS PER-PROBE. A pre-granted probe holds its one
  // entry from spawn, which is the only way to ask what a SINGLE form does —
  // the approval path adds every spelling.
  const startingAllowlist = probe.preGranted
    ? [...BASE_ALLOWLIST, probe.preGranted]
    : BASE_ALLOWLIST;

  const sup = await startSupervisor({
    handle,
    extraDirs: [root],
    allowedTools: startingAllowlist,
    log: () => undefined,
  });

  try {
    await deliverToSupervisor(handle, {
      id: 1,
      to: handle,
      from: 'permit-harness',
      ts: Date.now(),
      body:
        `Attempt exactly this, once, as a single tool call: ${probe.command}\n` +
        `Do NOT rephrase it, do NOT substitute anything, and do NOT work around a block. ` +
        `If you are blocked, say so and stop.`,
    });

    const answered = new Set();
    const deadline = Date.now() + SETTLE_MS;
    // 🛑 ACCUMULATED, NOT REPLACED. This was `[...BASE_ALLOWLIST, row.grant]`,
    // so a probe answering two approvals kept the second grant and silently
    // dropped the first. The set is what a record is keyed on.
    // ⚠️ A PRE-GRANTED ENTRY COUNTS AS A GRANT. It was in force when the
    // command ran, which is exactly what a record is keyed on, so the
    // one-grant rule and the refused-under-grant rule both apply unchanged.
    const grantedEntries = probe.preGranted ? [probe.preGranted] : [];

    while (Date.now() < deadline && !probe.moved()) {
      await sleep(2000);

      for (const row of dao.pendingApprovals(db, `${handle}-agent`)) {
        if (answered.has(row.id)) continue;
        answered.add(row.id);

        const outcome = answerAndNotify(db, row.id, 'approve', 'permit-harness');

        console.log(`   approval ${row.id}: ${outcome.kind}  grant=${row.grant ?? '(none)'}`);

        if (outcome.kind === 'answered' && row.grant && !grantedEntries.includes(row.grant)) {
          grantedEntries.push(row.grant);
        }
      }
    }

    const worked = probe.moved();

    console.log(`   target moved: ${worked}`);

    const note = probe.note ? probe.note() : null;

    if (note) console.log(`   ${note}`);

    observations.push({
      probe: probe.label,
      attempted: probe.command,
      approvals: [...answered],
      // 🛑 THE FULL SET, NOT THE LAST ENTRY. `classify()`'s refused branch
      // keys on `sameSet(r.allowlist, grants)`, so the one field a
      // `refused_under_grant` record would depend on was the one this threw
      // away. claude1 on this PR.
      allowlist: grantedEntries.length > 0 ? [...BASE_ALLOWLIST, ...grantedEntries] : null,
      grants: grantedEntries,
      targetMoved: worked,
      note,
      at: new Date().toISOString(),
    });

    /**
     * 🛑 EXACTLY ONE GRANT, OR NO PERMIT RECORD.
     *
     * `classify()`'s permitted branch is a CONTAINMENT test:
     * `grants.includes(normalise(r.allowlistEntry))`. So a record naming one
     * entry asserts that THAT entry is sufficient. If the target only moved
     * because two grants were present, that over-claims in the permissive
     * direction, and a later query holding the second entry alone would be
     * told `permitted`.
     *
     * A compound command is the shape that draws a second denial, so this is
     * live for probes 5 and 6 rather than theoretical. `c12c81d` is in the
     * corpus because a reworded compound retry was blocked again.
     *
     * The multi-grant case goes to the observation file with its full
     * `grants` array instead. Widening the field is NOT the fix: the
     * permitted branch would have to require every entry, which is a
     * `classify()` change and so part of lee's ruling. claude1 on this PR.
     */
    if (worked && grantedEntries.length > 1) {
      withheld.push({ probe: probe.label, grants: grantedEntries.length });
      console.log(`   PERMIT WITHHELD: the target moved under ${grantedEntries.length} grants, and a record names one`);
    }

    if (!worked && grantedEntries.length > 0) {
      underGrant.push({
        outcome: 'refused_under_grant',
        probe: probe.label,
        // ⚠️ PLURAL, unlike the permit records' single `approvalId`. A probe
        // can answer more than one approval before its target is checked.
        approvalIds: [...answered],
        attempted: probe.command,
        allowlist: [...BASE_ALLOWLIST, ...grantedEntries],
        evidence:
          `${new Date().toISOString().slice(0, 10)}: ${probe.label} — approved under ` +
          `${grantedEntries.length} grant(s) and the target did not move.` +
          `${note ? ` ${note}.` : ''}${probe.caveat ? ` ${probe.caveat}` : ''}` +
          ' HISTORICAL: the scratch directory is deleted when this run ends.',
      });

      console.log(`   REFUSED UNDER GRANT: approved, and the target did not move`);
    }

    if (worked && grantedEntries.length === 1) {
      captured.push({
        outcome: 'permitted',
        probe: probe.label,
        approvalId: [...answered].pop() ?? null,
        attempted: probe.command,
        // ⚠️ STILL A SINGLE ENTRY. `classify()`'s permitted branch asks
        // `grants.includes(normalise(r.allowlistEntry))`, so widening this to
        // a set would break the half that already works.
        allowlistEntry: grantedEntries[0],
        evidence:
          `${new Date().toISOString().slice(0, 10)}: ${probe.label} — the target moved after ` +
          `the grant was added.${probe.caveat ? ` ${probe.caveat}` : ''}` +
          ' HISTORICAL: the scratch directory is deleted when this run ends.',
      });
    }
  } finally {
    await sup.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

// 🛑 ONE RESULT PER PROBE, NAMED. `captured.length > 0` exits 0 on 1 of 4,
// which certifies a run that mostly failed. claude1 on PR 43.
const missing = PROBE_LABELS.filter((l) => !captured.some((c) => c.probe === l));

console.log(`\n${captured.length} of ${PROBE_LABELS.length} probe(s) produced a permit, 0 clicks needed.`);

for (const m of missing) {
  const w = withheld.find((x) => x.probe === m);

  if (w) console.log(`  PERMIT WITHHELD: ${m} — worked under ${w.grants} grants, see the observation log`);
  else console.log(`  NO PERMIT: ${m}`);
}

for (const c of captured) console.log(`  ${c.allowlistEntry}`);

// 🛑 WRITTEN BESIDE THE FIXTURE, NOT INTO IT. Merging is `rebuild-corpus.mjs`
// work, and a harness that edits the fixture directly is how an inline
// rebuild silently discarded a record earlier today.
writeFileSync(join(ROOT, 'test', 'fixtures', 'captured-permits.pending.json'), `${JSON.stringify(captured, null, 2)}\n`);
console.log('\nwrote test/fixtures/captured-permits.pending.json');

writeFileSync(
  join(ROOT, 'test', 'fixtures', 'captured-refused-under-grant.pending.json'),
  `${JSON.stringify(underGrant, null, 2)}\n`,
);
console.log(`wrote test/fixtures/captured-refused-under-grant.pending.json — ${underGrant.length} record(s)`);

mkdirSync(join(ROOT, 'measurements'), { recursive: true });

const log = join(ROOT, 'measurements', `permit-run-${process.pid}.json`);

writeFileSync(log, `${JSON.stringify(observations, null, 2)}\n`);
console.log(`wrote ${log} — ${observations.length} observation(s), permits and non-permits alike`);

process.exit(missing.length === 0 ? 0 : 1);
