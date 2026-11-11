import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test(
  '🛑 killing the docker-run process removes the --rm container',
  { skip: dockerAvailable() ? false : 'docker is not available here' },
  async () => {
    const name = `chat-mcp-removal-${process.pid}`;
    const child = spawn('docker', ['run', '-i', '--rm', '--name', name, 'alpine', 'sleep', '300']);

    // Wait for the container to actually exist before killing it, otherwise a
    // pass could mean "it never started".
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const out = execFileSync('docker', ['ps', '-q', '-f', `name=${name}`]).toString().trim();
        if (out) {
          clearInterval(poll);
          resolve(undefined);
        } else if (Date.now() - started > 20000) {
          clearInterval(poll);
          reject(new Error('container never started'));
        }
      }, 200);
    });

    child.kill();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('docker run did not exit within 20s of kill()')), 20000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });

    // `--rm` removal is asynchronous, so poll rather than reading once.
    const gone = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const out = execFileSync('docker', ['ps', '-a', '-q', '-f', `name=${name}`])
          .toString()
          .trim();
        if (!out) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - started > 20000) {
          clearInterval(poll);
          resolve(false);
        }
      }, 300);
    });

    assert.ok(gone, `container ${name} was still listed by docker ps -a after kill()`);
  },
);
