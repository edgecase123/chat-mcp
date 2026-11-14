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

  return {
    emit: (chunk: string) => child.stderr.emit('data', chunk),
    // A dying process closes its pipe. `end` is the only signal that no
    // further newline is coming.
    end: () => child.stderr.emit('end'),
    lines,
  };
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

/**
 * 🔴 THE CASE THIS WHOLE CHANGE EXISTS FOR, AND THE FIRST CUT LOST IT.
 *
 * A process that dies mid-line never sends the closing newline. Draining only
 * on `\n` meant the buffer still held the last line when the pipe closed, so
 * the ONE line naming why the container died was the one line dropped. Raised
 * by claude2 on PR 238 with a failing repro against this harness.
 */
test('🚨 a final line with NO trailing newline is delivered when the stream ends', () => {
  const w = wired();

  w.emit('npm error code EACCES');
  assert.deepEqual(w.lines, [], 'a partial line must wait for a newline or an end');

  w.end();

  assert.deepEqual(w.lines, ['npm error code EACCES']);
});

test('🚨 an end after a complete line does not re-deliver or invent one', () => {
  const w = wired();

  w.emit('done\n');
  w.end();

  assert.deepEqual(w.lines, ['done'], 'end must not duplicate or emit a blank');
});

/** The negative control: an end on an empty buffer emits nothing. */
test('🚨 an end with nothing buffered emits nothing', () => {
  const w = wired();

  w.end();

  assert.deepEqual(w.lines, []);
});

/** Whitespace-only residue is still residue, and still not worth a line. */
test('🚨 an end flushing only whitespace emits nothing', () => {
  const w = wired();

  w.emit('   ');
  w.end();

  assert.deepEqual(w.lines, []);
});

/**
 * 🟡 `\r` IS A BREAK TOO. `npm` and `docker pull` draw progress by returning
 * the carriage and never sending a newline, so a `\n`-only split buffered the
 * whole run and delivered it as one entry thousands of characters long.
 * Measured by claude2 on PR 238.
 */
test('🚨 carriage-return progress output is split, not buffered into one entry', () => {
  const w = wired();

  w.emit('10%\r20%\r30%\r');

  assert.deepEqual(w.lines, ['10%', '20%', '30%']);
});

test('🚨 a CRLF pair is ONE break, not two', () => {
  const w = wired();

  w.emit('first\r\nsecond\r\n');

  assert.deepEqual(w.lines, ['first', 'second'], 'CRLF must not emit a blank between lines');
});

/** A real npm shape: progress by \r, then the error by \n, then death. */
test('🚨 progress then a final error with no trailing break delivers every part', () => {
  const w = wired();

  w.emit('fetch 40%\rfetch 80%\r');
  w.emit('npm error code EACCES\nnpm error path /work');
  w.end();

  assert.deepEqual(w.lines, ['fetch 40%', 'fetch 80%', 'npm error code EACCES', 'npm error path /work']);
});
