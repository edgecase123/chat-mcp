import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-wakecmd-'));

const { fileWatchTransport } = await import('../../src/notify/transport.js');

/**
 * Kill the whole process GROUP, never throw.
 *
 * 🛑 `child.kill()` REACHES THE SHELL ONLY. These children are `sh -c "node
 * -e ..."`, so if the shell forks rather than execs, killing it orphans the
 * node watcher — and that watcher holds this process's stdout pipe open, so
 * `node --test` never exits and the file hangs instead of failing. SIGKILL
 * makes it worse, because a shell cannot forward a signal it never receives.
 *
 * Spawning detached puts the child in its own group, and a negative pid
 * signals every member of it.
 */
function kill(child: ReturnType<typeof spawn> | null): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Run the real wake command and collect every line it emits.
 *
 * 🛑 THE COMMAND IS A STRING, SO NOTHING ELSE CHECKS IT. tsc sees a template
 * literal and the other tests regex-match it. Neither can tell you it RUNS, or
 * that it emits a line per message. Only spawning it can.
 */
async function wakesFor(writes: string[]): Promise<string[]> {
  const sub = fileWatchTransport.subscribe('probe');
  const path = sub.endpoint!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');

  const child = spawn('sh', ['-c', sub.command], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const lines: string[] = [];
  child.stdout.on('data', (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) lines.push(l.trim());
  });
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });

  await new Promise((r) => setTimeout(r, 300));
  for (const w of writes) {
    writeFileSync(path, w);
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 200));
  kill(child);

  assert.equal(stderr, '', `the command itself failed: ${stderr}`);
  return lines;
}

test('🛑 the command RUNS and prints the message body, not the word "wake"', { timeout: 30_000 }, async () => {
  const env = JSON.stringify({ id: 7, to: '#gate', from: 'alice', ts: 1, body: 'hello' });
  const lines = await wakesFor([env]);

  assert.equal(lines.length, 1, `expected one wake, got ${lines.length}`);
  assert.equal(lines[0], env, 'the wake must carry the envelope verbatim');
  assert.ok(!lines.includes('wake'), 'a bare wake carries nothing to triage');
});

test('🛑 every DISTINCT id wakes, so no message is lost to the dedupe', { timeout: 30_000 }, async () => {
  const envs = [1, 2, 3].map((id) => JSON.stringify({ id, to: 'probe', from: 'a', ts: id }));
  const lines = await wakesFor(envs);

  assert.equal(lines.length, 3, `expected 3 wakes, got ${lines.length}`);
  assert.deepEqual(lines.map((l) => (JSON.parse(l) as { id: number }).id), [1, 2, 3]);
});

test('a REPEAT of the same id is dropped, which is the only thing the dedupe may drop', { timeout: 30_000 }, async () => {
  const env = JSON.stringify({ id: 9, to: 'probe', from: 'a', ts: 1 });
  const lines = await wakesFor([env, env]);

  assert.equal(lines.length, 1, 'an identical id twice is a double-fire, not a second message');
});

test('🛑 `id: 0` is the SYSTEM sentinel and must wake EVERY time', { timeout: 30_000 }, async () => {
  // Keying the dedupe on a raw id would collapse these two into one, and the
  // second system event would vanish with no error anywhere.
  //
  // 🛑 AT LEAST, NEVER EXACTLY. The event count per write is the PLATFORM's,
  // not ours: `writePrivateFileSync` is writeFileSync + chmodSync, and that
  // is 1 fs.watch event on darwin and 2 inotify events on linux. Measured —
  // 3 writes gave 3 events on darwin and 6 in a node:22 container. An exact
  // 2 here passed on darwin and failed on linux, which is the whole reason
  // this file exists.
  const a = JSON.stringify({ id: 0, to: 'probe', from: 'system', ts: 1 });
  const b = JSON.stringify({ id: 0, to: 'probe', from: 'system', ts: 1 });
  const lines = await wakesFor([a, b]);

  assert.ok(lines.length >= 2, `id:0 twice must not be collapsed, got ${lines.length}`);
  // The denominator: every line really is the sentinel, not some other wake.
  assert.ok(lines.every((l) => l === a), 'a non-sentinel line crept in');
});

test('🛑 a bare-timestamp payload must wake every time, repeats included', { timeout: 30_000 }, async () => {
  // `notifyPeer` with no envelope writes `String(Date.now())`, so two of them
  // inside one millisecond are byte-identical and neither may be swallowed.
  const lines = await wakesFor(['1793600000000', '1793600000000']);

  // At least, never exactly — see the sentinel test above for why.
  assert.ok(lines.length >= 2, `two bare timestamps must not be collapsed, got ${lines.length}`);
  assert.ok(lines.every((l) => l === '1793600000000'));
});

test('an empty write is not a message and does not wake', { timeout: 30_000 }, async () => {
  const lines = await wakesFor(['', '']);
  assert.equal(lines.length, 0);
});

/**
 * 🛑 THE PROBE IS A STRING TOO, AND EVERY OTHER TEST ONLY REGEXES IT.
 *
 * An OVER-anchored pattern returns 0 for ever, and 0 is also the correct
 * answer for a handle with nothing armed — so the failure reads identically to
 * success and every string assertion still passes. Only running it both ways
 * can tell them apart.
 */
async function probeCount(handle: string, armed: boolean): Promise<number> {
  const sub = fileWatchTransport.subscribe(handle);
  mkdirSync(dirname(sub.endpoint!), { recursive: true });
  writeFileSync(sub.endpoint!, '');

  const child = armed
    ? spawn('sh', ['-c', sub.command], { stdio: 'ignore', detached: true })
    : null;
  await new Promise((r) => setTimeout(r, 400));

  const out = await new Promise<string>((resolve) => {
    const p = spawn('sh', ['-c', sub.probeCommand!], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = '';
    p.stdout.on('data', (b: Buffer) => { s += b.toString(); });
    p.on('close', () => resolve(s.trim()));
  });

  kill(child);
  await new Promise((r) => setTimeout(r, 150));
  return Number(out);
}

test('🛑 the probe counts 1 for a LIVE watcher, so it is not over-anchored', { timeout: 30_000 }, async () => {
  assert.equal(await probeCount('probecount', true), 1);
});

test('🛑 the probe counts 0 when nothing is armed, so it does not count itself', { timeout: 30_000 }, async () => {
  assert.equal(await probeCount('probezero', false), 0);
});

test('🛑 a PREFIX handle does not count its sibling, measured not reasoned', { timeout: 30_000 }, async () => {
  const rw = fileWatchTransport.subscribe('pfx');
  const rw2 = fileWatchTransport.subscribe('pfx2');
  mkdirSync(dirname(rw.endpoint!), { recursive: true });
  writeFileSync(rw.endpoint!, '');
  writeFileSync(rw2.endpoint!, '');

  // Only the SIBLING is armed. A prefix-matching probe for `pfx` would see it.
  const child = spawn('sh', ['-c', rw2.command], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 400));

  const count = await new Promise<string>((resolve) => {
    const p = spawn('sh', ['-c', rw.probeCommand!], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = '';
    p.stdout.on('data', (b: Buffer) => { s += b.toString(); });
    p.on('close', () => resolve(s.trim()));
  });

  kill(child);
  assert.equal(Number(count), 0, 'pfx counted pfx2’s watcher as its own');
});
