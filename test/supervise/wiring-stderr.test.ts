import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { wireAgentChild } from '../../src/supervise/drivers/wiring.js';
import type { VendorSpawn } from '../../src/supervise/vendor.js';

/**
 * 🛑 THE LINE BUFFERING LIVES HERE, SO IT MUST BE TESTED HERE.
 *
 * `child-stderr-logged.test.ts` fakes `AgentChild`, which means its `onStderr`
 * callback is invoked directly and the buffering below never runs. Its
 * empty-chunk case passed only once the SUPERVISOR grew its own guard — a
 * reading that said nothing about this code. A chunk is not a line: `npm`
 * emits partial writes, and logging raw chunks splits one error across
 * entries.
 */

function fakeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout.setEncoding = () => undefined;
  stderr.setEncoding = () => undefined;

  return {
    stdout,
    stderr,
    stdin: { write: () => true },
    on: () => undefined,
    kill: () => undefined,
  } as unknown as ChildProcessWithoutNullStreams & { stderr: EventEmitter };
}

const vendor: Pick<VendorSpawn, 'routeEvent' | 'encodeInput' | 'reportsUsage' | 'reportsContext'> = {
  routeEvent: () => undefined,
  encodeInput: (t: string) => t,
  reportsUsage: false,
  reportsContext: false,
};

function wired() {
  const child = fakeChild();
  const lines: string[] = [];
  const agent = wireAgentChild(child, vendor);
  agent.onStderr((l) => lines.push(l));

  return { emit: (chunk: string) => child.stderr.emit('data', chunk), lines };
}

test('a complete line is delivered once', () => {
  const w = wired();

  w.emit('npm error code EACCES\n');

  assert.deepEqual(w.lines, ['npm error code EACCES']);
});

test('two lines in one chunk are delivered separately', () => {
  const w = wired();

  w.emit('first\nsecond\n');

  assert.deepEqual(w.lines, ['first', 'second']);
});

/** 🛑 THE ONE THE SUPERVISOR-LEVEL FAKE COULD NOT REACH. */
test('a line split across two chunks is delivered ONCE, whole', () => {
  const w = wired();

  w.emit('npm error co');
  assert.deepEqual(w.lines, [], 'a partial line must not be delivered yet');

  w.emit('de EACCES\n');

  assert.deepEqual(w.lines, ['npm error code EACCES']);
});

test('a trailing partial line is held, not dropped, until its newline', () => {
  const w = wired();

  w.emit('done\nhalf');
  assert.deepEqual(w.lines, ['done']);

  w.emit('\n');

  assert.deepEqual(w.lines, ['done', 'half']);
});

/** The negative control: a blank flush must not produce an entry. */
test('blank and whitespace-only lines are dropped', () => {
  const w = wired();

  w.emit('\n');
  w.emit('   \n');
  w.emit('\t\n');

  assert.deepEqual(w.lines, []);
});

/** A subscriber attached late still receives subsequent lines. */
test('every subscriber receives each line', () => {
  const child = fakeChild();
  const a: string[] = [];
  const b: string[] = [];
  const agent = wireAgentChild(child, vendor);
  agent.onStderr((l) => a.push(l));
  agent.onStderr((l) => b.push(l));

  child.stderr.emit('data', 'boom\n');

  assert.deepEqual(a, ['boom']);
  assert.deepEqual(b, ['boom']);
});
