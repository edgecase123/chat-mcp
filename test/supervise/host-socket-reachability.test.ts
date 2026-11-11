import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerLaneSkip } from '../support/docker-lane.js';

/**
 * Can a containerized agent reach a unix socket the HOST created inside the
 * bind-mounted state dir?
 *
 * 🛑 THIS IS #133'S TRANSPORT QUESTION, AND NOTHING IN THE REPO ANSWERED IT.
 * `spawnContainerized` already bind-mounts `stateDir()` into the container,
 * and `socketDir()` lives under it — so a host broker listening on
 * `~/.chat-mcp/sock/<handle>` would be reachable from inside the container for
 * free, with no new network knob, exactly as #133 proposes.
 *
 * **That is a claim about Docker Desktop's bind-mount implementation, not
 * about this code.** It has to be measured on the machine the design will run
 * on, because the answer differs by platform and by mount driver.
 *
 * **MEASURED ANSWER: NO.** The directory entry is listed, a regular file in
 * the same directory crosses fine, and nothing can be sent over the socket.
 * So #133's broker cannot ride a socket in the mounted state dir on this host.
 *
 * 🛑 THE ERROR SHAPE IS NOT STABLE, AND THIS TEST DELIBERATELY DOES NOT PIN
 * IT. Measured 2026-11-11 on Docker Desktop 24.0.7 / macOS, the container's
 * view of one live host socket came back BOTH ways in one session:
 *
 *   stat ENOTSUP  existsSync false  connect ENOTSUP        (early runs)
 *   stat ENOENT   existsSync true   connect ECONNREFUSED   (5 of 5 later)
 *
 * An earlier draft asserted the first row and went red when the second
 * appeared. Pinning an errno here buys a flaky test and nothing else.
 *
 * ⚠️ A RED RUN HERE IS A DESIGN SIGNAL, NOT A REGRESSION. It means traffic now
 * crosses, and #133's simplest transport is available again. Re-read the
 * transport decision rather than deleting the assertion.
 */

/** The image needs a runtime that can open a unix socket, so not bare alpine. */
const CLIENT_IMAGE = 'node:22-slim';

/**
 * 🛑 THE MOUNTED DIRECTORY MUST BE SHORT, AND THIS IS NOT COSMETIC. A unix
 * socket path is capped at ~104 bytes, and `listen()` fails `EINVAL` past it —
 * the same cap `src/util/paths.ts` keeps `~/.chat-mcp/sock/` short for. A
 * first version of this probe used a long scratchpad path and reported
 * `EINVAL`, which reads as "the platform refuses unix sockets here" rather
 * than "the path was too long".
 */
function shortProbeDir(): string {
  return mkdtempSync('/tmp/cmp-sock-');
}

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * How long the client container may take to produce its verdict.
 *
 * 🛑 `docker run` PULLS THE IMAGE INSIDE THIS BUDGET (#150). Exceeding it is
 * not evidence the transport failed, which is why the rejection below carries
 * docker's own stderr and exit code rather than just a timeout message.
 */
const CLIENT_BOUND_MS = 60000;

/** What the in-container client prints, one fact per line, so each is assertable. */
const CLIENT_SCRIPT = `
const net = require('net'), fs = require('fs');
const p = '/probe/s';

// 🛑 THE CONTROL, AND IT IS LOAD-BEARING. A plain file written to the same
// directory by the same host process. Without it, a failure to see the socket
// is indistinguishable from the bind mount not working at all — and those two
// have opposite consequences for #133.
let control = 'no';
try { control = fs.readFileSync('/probe/control.txt', 'utf8').trim(); }
catch (e) { control = 'read-failed:' + e.code; }
console.log('CONTROL=' + control);

// 🛑 THE ENTRY IS LISTED. This is the half that makes the failure a SILENT
// WRONG ANSWER rather than an error: the directory entry is right there, so
// nothing looks missing, but it cannot be stat'd.
console.log('LISTED=' + (fs.readdirSync('/probe').includes('s') ? 'yes' : 'no'));

let visible = 'no';
try { visible = fs.statSync(p).isSocket() ? 'yes' : 'not-a-socket'; }
catch (e) { visible = 'stat-failed:' + e.code; }
console.log('VISIBLE=' + visible);

// What the production guards call. Printed for diagnosis only: it has been
// observed BOTH true and false against a live host socket, so nothing below
// asserts it.
//
// 🛑 NO BACKTICKS IN THIS STRING. It is a template literal, so a backtick
// here closes it and esbuild reports a syntax error 80 lines away.
console.log('EXISTS_SYNC=' + fs.existsSync(p));
const c = net.connect(p);
c.on('connect', () => c.write('ping'));
c.on('data', (d) => { console.log('REPLY=' + d.toString().trim()); process.exit(0); });
c.on('error', (e) => { console.log('CONNECT_ERROR=' + e.code); process.exit(3); });
setTimeout(() => { console.log('CONNECT_TIMEOUT'); process.exit(4); }, 15000);
`;

test(
  '🛑 a container CANNOT reach a host unix socket in the bind-mounted state dir (#133)',
  { skip: dockerLaneSkip(process.env, dockerAvailable) },
  async () => {
    const dir = shortProbeDir();
    const socketPath = join(dir, 's');
    const name = `cmp-sock-probe-${process.pid}`;

    let server: Server | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      // The control's content, written by the host into the mounted dir.
      writeFileSync(join(dir, 'control.txt'), 'mount-works\n');

      // The host end, which is what a broker would be.
      server = createServer((socket) => {
        socket.on('data', (d: Buffer) => socket.write(`pong:${d.toString().trim()}\n`));
      });

      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(socketPath, () => resolve());
      });

      // 🛑 PROVE THE HOST END EXISTS BEFORE BLAMING THE CONTAINER. Without
      // this, a `listen()` that silently produced nothing would surface as the
      // container failing to connect — the wrong half of the system.
      assert.ok(
        statSync(socketPath).isSocket(),
        `host did not create a socket at ${socketPath}`,
      );

      child = spawn('docker', [
        'run',
        '-i',
        '--rm',
        '--name',
        name,
        '-v',
        `${dir}:/probe`,
        CLIENT_IMAGE,
        'node',
        '-e',
        CLIENT_SCRIPT,
      ]) as ChildProcessWithoutNullStreams;

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // A spawn failure arrives as an `error` event, never on stderr and never
      // as an exit code.
      let spawnError: Error | undefined;
      child.on('error', (err: Error) => {
        spawnError = err;
      });

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`client did not finish within ${CLIENT_BOUND_MS}ms`)),
            CLIENT_BOUND_MS,
          );
          child?.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        },
      );

      /** Everything the client reported, so a rejection names its own cause. */
      const evidence = [
        spawnError ? `spawn error: ${spawnError.message}` : 'spawn ok',
        `exit: code=${exit.code} signal=${exit.signal}`,
        `stdout:\n${stdout.trim() || '(empty)'}`,
        `stderr:\n${stderr.trim() || '(empty)'}`,
      ].join('\n');

      // 🛑 THE CONTROL IS ASSERTED FIRST, AND IT IS WHAT MAKES THE REST MEAN
      // ANYTHING. If a plain file does not cross the mount, every socket
      // result below is explained by a broken mount and says nothing about
      // sockets at all.
      assert.match(
        stdout,
        /^CONTROL=mount-works$/m,
        `the bind mount did not carry a plain file, so this run says NOTHING about unix sockets\n${evidence}`,
      );

      // 🛑 THE ENTRY IS LISTED, WHICH IS WHY THIS IS A TRAP RATHER THAN AN
      // ERROR. A directory listing shows the socket, so nothing looks absent,
      // and the failure only appears when something tries to use it.
      assert.match(
        stdout,
        /^LISTED=yes$/m,
        `the socket entry is no longer listed inside the container, so the failure shape changed\n${evidence}`,
      );

      // 🛑 THE ONE STABLE PROPERTY, AND THEREFORE THE ONLY ASSERTION. No
      // traffic crosses. Every observed run failed to get a reply, whatever
      // errno it reported on the way.
      //
      // ⚠️ THIS IS AN ABSENCE PROOF, SO IT FAILS OPEN BY ITS NATURE. The
      // CONTROL above is what stops it passing for the wrong reason: a run
      // where the mount carried nothing at all would also produce no reply.
      //
      // 🛑 PROVEN NON-VACUOUS, NOT ASSUMED SO. The same client code against a
      // socket created INSIDE the container printed `REPLY=pong:ping`, which
      // fails this assertion. So unix sockets work in the container; it is
      // crossing the bind mount that does not:
      //
      //   server inside the container   -> REPLY=pong:ping   (would fail here)
      //   server on the host, mounted   -> no reply          (what we assert)
      assert.doesNotMatch(
        stdout,
        /^REPLY=/m,
        `the container got a reply over the mounted socket, so a broker CAN ride it and #133's transport decision should be re-read\n${evidence}`,
      );

      // The client must have actually reached the connect attempt, or "no
      // reply" proves nothing about the socket.
      assert.match(
        stdout,
        /^(CONNECT_ERROR=|CONNECT_TIMEOUT)/m,
        `the client never reported a connect outcome, so this run says nothing\n${evidence}`,
      );

    } finally {
      // Whatever this test concluded, it must not leave a container or a
      // socket file behind.
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // Already gone — the expected case.
      }

      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
