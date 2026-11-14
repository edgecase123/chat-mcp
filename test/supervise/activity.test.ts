import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';

import {
  ACTIVITY_THROTTLE_MS,
  PULSE_FAILSAFE_MS,
  activityTarget,
  createActivityReporter,
} from '../../src/supervise/activity.js';

/**
 * #240. The supervisor reads a child's stdout and the browser shows nothing,
 * so a ninety-second turn and a dead child look identical. These tests cover
 * the supervisor half: where it posts, how often, and what it does when
 * nothing is listening.
 *
 * 🛑 EVERY TEST HERE RUNS AGAINST A REAL http SERVER ON A REAL PORT. A fake
 * `fetch` would assert that this file calls the function it calls, which is
 * the vacuity the repo keeps catching. The server records what arrived.
 */

function stateRig(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'activity-'));

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A web server that records every activity POST it receives. */
async function recordingServer(): Promise<{
  server: Server;
  port: number;
  seen: { path: string; body: string; cookie: string | undefined; host: string | undefined }[];
  close: () => Promise<void>;
}> {
  const seen: { path: string; body: string; cookie: string | undefined; host: string | undefined }[] = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({
        path: req.url ?? '',
        body,
        cookie: req.headers.cookie,
        host: req.headers.host,
      });
      res.statusCode = 204;
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const addr = server.address();
  assert.ok(addr && typeof addr === 'object', 'the rig server did not bind a port');

  return {
    server,
    port: addr.port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Let the fire-and-forget POSTs land. They are deliberately not awaited. */
function settle(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('🛑 the two constants are the values lee ruled, not a developer default', () => {
  // lee, 2026-11-14: "Q3: I accept your suggestion" — 250ms throttle, 30s
  // failsafe. The failsafe is 30s and NOT the 2s originally sketched, because
  // turn-end decays the pulse now and a short failsafe re-introduces the
  // mid-turn blackout it replaced.
  assert.equal(ACTIVITY_THROTTLE_MS, 250);
  assert.equal(PULSE_FAILSAFE_MS, 30_000);
});

test('🛑 no web-url means NOTHING IS LISTENING, so there is no target at all', () => {
  const rig = stateRig();

  try {
    // The whole point: the existence check is what stops a connection-refused
    // log line per stream event. A target here would mean a doomed POST.
    assert.equal(activityTarget(rig.dir), null);
  } finally {
    rig.cleanup();
  }
});

test('🛑 a web-url with NO handshake token is still no target', () => {
  const rig = stateRig();

  try {
    writeFileSync(join(rig.dir, 'web-url'), 'http://127.0.0.1:4321/');

    // 🛑 BOTH FILES OR NEITHER. The route is cookie-authenticated, so a url
    // without a token produces a 401 on every single event — the same log
    // flood the check exists to prevent, arriving as failures instead of
    // refusals.
    assert.equal(activityTarget(rig.dir), null);
  } finally {
    rig.cleanup();
  }
});

test('⚠️ control — both files present yields the port and the token', () => {
  const rig = stateRig();

  try {
    writeFileSync(join(rig.dir, 'web-url'), 'http://127.0.0.1:4321/\n');
    writeFileSync(join(rig.dir, 'web-handshake'), 'sekrit\n');

    const target = activityTarget(rig.dir);

    assert.ok(target, 'both files present and still no target');
    assert.equal(target.origin, 'http://127.0.0.1:4321');
    assert.equal(target.token, 'sekrit', 'the trailing newline reached the token');
  } finally {
    rig.cleanup();
  }
});

test('🛑 a tick REACHES the server, authenticated, with the handle in the BODY', async () => {
  const rig = stateRig();
  const web = await recordingServer();

  try {
    writeFileSync(join(rig.dir, 'web-url'), `http://127.0.0.1:${web.port}/`);
    writeFileSync(join(rig.dir, 'web-handshake'), 'tok123');

    const report = createActivityReporter({ handle: 'claude2', stateDir: () => rig.dir });

    report('tick');
    await settle();

    assert.equal(web.seen.length, 1, 'the tick did not arrive');
    assert.equal(web.seen[0]!.path, '/api/activity');

    // 🛑 THE HANDLE IS IN THE BODY, NOT THE PATH. `requiredCapability` matches
    // an exact `Set<string>`, so a `/api/activity/<handle>` path falls through
    // to its `admin` default and a write-scoped credential is refused. Every
    // other route in `server.ts` is a fixed path with a JSON body too.
    assert.deepEqual(JSON.parse(web.seen[0]!.body), { handle: 'claude2', phase: 'tick' });

    // The supervisor has no cookie jar, so it sets the header itself.
    assert.match(web.seen[0]!.cookie ?? '', /tok123/);

    // The Host allowlist is checked before auth and before routing.
    assert.equal(web.seen[0]!.host, `127.0.0.1:${web.port}`);
  } finally {
    await web.close();
    rig.cleanup();
  }
});

test('🛑 bursts THROTTLE, so a chatty turn cannot flood the web server', async () => {
  const rig = stateRig();
  const web = await recordingServer();

  try {
    writeFileSync(join(rig.dir, 'web-url'), `http://127.0.0.1:${web.port}/`);
    writeFileSync(join(rig.dir, 'web-handshake'), 'tok123');

    const report = createActivityReporter({ handle: 'claude2', stateDir: () => rig.dir });

    for (let i = 0; i < 20; i++) report('tick');
    await settle();

    // A real turn emits an assistant event per tool call and per text block.
    // The dot is binary, so anything past the first in a window is pure cost.
    assert.equal(web.seen.length, 1, `20 ticks in one window sent ${web.seen.length} posts`);
  } finally {
    await web.close();
    rig.cleanup();
  }
});

/**
 * 🛑 THE PAIRED CONTROL, AND IT IS THE ONE THAT CATCHES A THROTTLE THAT NEVER
 * REOPENS. A reporter that sent exactly one POST and then went silent forever
 * would pass the burst test above and show a dot that pulses once per session.
 */
test('⚠️ control — the throttle REOPENS, so a later tick is not swallowed', async () => {
  const rig = stateRig();
  const web = await recordingServer();

  try {
    writeFileSync(join(rig.dir, 'web-url'), `http://127.0.0.1:${web.port}/`);
    writeFileSync(join(rig.dir, 'web-handshake'), 'tok123');

    let now = 1_000;
    const report = createActivityReporter({
      handle: 'claude2',
      stateDir: () => rig.dir,
      now: () => now,
    });

    report('tick');
    now += ACTIVITY_THROTTLE_MS + 1;
    report('tick');
    await settle();

    assert.equal(web.seen.length, 2, 'the throttle never reopened');
  } finally {
    await web.close();
    rig.cleanup();
  }
});

/**
 * 🛑 AN END IS NOT A TICK AND MUST NEVER BE THROTTLED. Turn-end is the signal
 * that CLEARS the pulse (lee's decision 3). Dropping one because a tick just
 * went out leaves the dot pulsing until the 30s failsafe — which is the
 * mid-turn-blackout bug inverted, and it looks like the agent never finished.
 */
test('🛑 an END is never throttled, even immediately after a tick', async () => {
  const rig = stateRig();
  const web = await recordingServer();

  try {
    writeFileSync(join(rig.dir, 'web-url'), `http://127.0.0.1:${web.port}/`);
    writeFileSync(join(rig.dir, 'web-handshake'), 'tok123');

    const report = createActivityReporter({ handle: 'claude2', stateDir: () => rig.dir });

    report('tick');
    report('end');
    await settle();

    assert.equal(web.seen.length, 2, 'the end was swallowed by the tick throttle');
    assert.deepEqual(JSON.parse(web.seen[1]!.body), { handle: 'claude2', phase: 'end' });
  } finally {
    await web.close();
    rig.cleanup();
  }
});

/**
 * 🛑 THE WEB SERVER IS DOWN MOST OF THE TIME — `server.ts` arms a 60s idle
 * shutdown at boot and exits once no browser holds an SSE stream. So a refused
 * connection is the NORMAL case, and it must cost nothing and say nothing.
 */
test('🛑 a dead web server costs one silent return, not a throw and not a log', async () => {
  const rig = stateRig();

  try {
    // A port nothing is listening on, with both files present — so the
    // existence check passes and the connection itself is refused.
    writeFileSync(join(rig.dir, 'web-url'), 'http://127.0.0.1:1/');
    writeFileSync(join(rig.dir, 'web-handshake'), 'tok123');

    const report = createActivityReporter({ handle: 'claude2', stateDir: () => rig.dir });

    // Must not throw synchronously, and must not reject later. An unhandled
    // rejection fails the whole file, which is the real assertion here.
    report('tick');
    await settle();

    // 🛑 THERE IS NO `log` HOOK TO ASSERT ON, AND ITS ABSENCE IS THE FIX. A
    // first cut had one, and this test is what proved the hook itself was the
    // per-event log flood the design forbids.
    assert.equal(typeof report, 'function', 'the reporter did not survive a refused post');
  } finally {
    rig.cleanup();
  }
});

test('🛑 a MISSING state dir does not throw either', async () => {
  const gone = join(tmpdir(), 'activity-does-not-exist-' + String(Date.now()));
  const report = createActivityReporter({ handle: 'claude2', stateDir: () => gone });

  report('tick');
  report('end');
  await settle(40);

  assert.equal(typeof report, 'function');
});

/**
 * ⚠️ A REPORTER IS PER HANDLE, so two supervised agents cannot throttle each
 * other. Sharing one window would make a busy agent hide a quiet one's dot.
 */
test('⚠️ two handles throttle independently', async () => {
  const rig = stateRig();
  const web = await recordingServer();

  try {
    mkdirSync(rig.dir, { recursive: true });
    writeFileSync(join(rig.dir, 'web-url'), `http://127.0.0.1:${web.port}/`);
    writeFileSync(join(rig.dir, 'web-handshake'), 'tok123');

    const a = createActivityReporter({ handle: 'claude1', stateDir: () => rig.dir });
    const b = createActivityReporter({ handle: 'claude2', stateDir: () => rig.dir });

    a('tick');
    b('tick');
    await settle();

    assert.equal(web.seen.length, 2, 'one handle swallowed the other');
    assert.deepEqual(
      web.seen.map((s) => JSON.parse(s.body).handle).sort(),
      ['claude1', 'claude2'],
    );
  } finally {
    await web.close();
    rig.cleanup();
  }
});
