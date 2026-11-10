import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-container-'));

const {
  imageNeedsBuild,
  buildImage,
  isConfirmed,
  markConfirmed,
  describePlan,
  IMAGE_TAG,
} = await import('../../src/supervise/container.js');

function fakeRunner(calls: { cmd: string; args: string[] }[], imageExists: boolean) {
  return (cmd: string, args: readonly string[]): Buffer => {
    calls.push({ cmd, args: [...args] });
    if (cmd === 'docker' && args[0] === 'image' && !imageExists) {
      throw new Error('no such image');
    }
    return Buffer.from('');
  };
}

test('no prior build and no image means a build is needed', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  assert.equal(imageNeedsBuild(fakeRunner(calls, false)), true);
});

test('after building, the SAME Dockerfile does not need a rebuild', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  buildImage(fakeRunner(calls, true));
  assert.equal(imageNeedsBuild(fakeRunner(calls, true)), false);
});

test('buildImage invokes docker build with the image tag', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  buildImage(fakeRunner(calls, true));
  const build = calls.find((c) => c.args[0] === 'build');
  assert.ok(build, 'docker build was never invoked');
  assert.ok(build!.args.includes(IMAGE_TAG));
});

test('a handle is unconfirmed until markConfirmed runs', () => {
  assert.equal(isConfirmed('claude1'), false);
  markConfirmed('claude1');
  assert.equal(isConfirmed('claude1'), true);
});

test('confirming one handle does not confirm another', () => {
  markConfirmed('claude1');
  assert.equal(isConfirmed('claude2'), false);
});

test('the printed plan names mounts, env var NAMES only, binary and network', () => {
  const plan = describePlan({
    mountPaths: ['/work', '/root/.chat-mcp'],
    envVarNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
    binary: 'claude',
    networkMode: 'bridge (default, full outbound)',
  });
  assert.match(plan, /\/work/);
  assert.match(plan, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(plan, /sk-ant/, 'a token VALUE must never be printed, only its name');
});
