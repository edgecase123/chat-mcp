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
 * 🛑 THE COMMAND IS A STRING, SO NOTHING ELSE CHECKS IT. tsc sees a template
 * literal and the other tests regex-match it. Neither can tell you it RUNS, or
 * that it emits one line per message. Only spawning it can.
 */
async function wakesFor(writes: string[]): Promise<string[]> {
  const sub = fileWatchTransport.subscribe('probe');
  const path = sub.endpoint!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');

  const child = spawn('sh', ['-c', sub.command], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  child.kill();

  assert.equal(stderr, '', `the command itself failed: ${stderr}`);
  return lines;
}

test('🛑 the command RUNS and prints the message body, not the word "wake"', async () => {
  const env = JSON.stringify({ id: 7, to: '#gate', from: 'alice', ts: 1, body: 'hello' });
  const lines = await wakesFor([env]);

  assert.equal(lines.length, 1, `expected one wake, got ${lines.length}`);
  assert.equal(lines[0], env, 'the wake must carry the envelope verbatim');
  assert.ok(!lines.includes('wake'), 'a bare wake carries nothing to triage');
});

test('🛑 every DISTINCT id wakes, so no message is lost to the dedupe', async () => {
  const envs = [1, 2, 3].map((id) => JSON.stringify({ id, to: 'probe', from: 'a', ts: id }));
  const lines = await wakesFor(envs);

  assert.equal(lines.length, 3, `expected 3 wakes, got ${lines.length}`);
  assert.deepEqual(lines.map((l) => (JSON.parse(l) as { id: number }).id), [1, 2, 3]);
});

test('a REPEAT of the same id is dropped, which is the only thing the dedupe may drop', async () => {
  const env = JSON.stringify({ id: 9, to: 'probe', from: 'a', ts: 1 });
  const lines = await wakesFor([env, env]);

  assert.equal(lines.length, 1, 'an identical id twice is a double-fire, not a second message');
});

test('🛑 `id: 0` is the SYSTEM sentinel and must wake EVERY time', async () => {
  // Keying the dedupe on a raw id would collapse these two into one, and the
  // second system event would vanish with no error anywhere.
  const a = JSON.stringify({ id: 0, to: 'probe', from: 'system', ts: 1 });
  const b = JSON.stringify({ id: 0, to: 'probe', from: 'system', ts: 1 });
  const lines = await wakesFor([a, b]);

  assert.equal(lines.length, 2, `id:0 twice must give two wakes, got ${lines.length}`);
});

test('🛑 a bare-timestamp payload must wake every time, repeats included', async () => {
  // `notifyPeer` with no envelope writes `String(Date.now())`, so two of them
  // inside one millisecond are byte-identical and neither may be swallowed.
  const lines = await wakesFor(['1793600000000', '1793600000000']);

  assert.equal(lines.length, 2, `two bare timestamps must give two wakes, got ${lines.length}`);
});

test('an empty write is not a message and does not wake', async () => {
  const lines = await wakesFor(['', '']);
  assert.equal(lines.length, 0);
});
