import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-handle-tokens-'));

const { mintToken, authenticateToken, revokeToken, handleTokensPath } = await import(
  '../../src/supervise/handle-tokens.js'
);

/**
 * 🛑 THE PAIRED CONTROL IS THE POINT. "A wrong token is refused" passes for a
 * function that refuses everything, so the accepting half ships beside it.
 */
test('🛑 a minted token resolves to ITS OWN handle, and another handle\'s token does NOT', () => {
  const mine = mintToken('tok-mine');
  const theirs = mintToken('tok-theirs');

  assert.equal(authenticateToken(mine), 'tok-mine');
  assert.equal(authenticateToken(theirs), 'tok-theirs');

  assert.notEqual(mine, theirs);
});

test('a token nobody minted is refused', () => {
  mintToken('tok-exists');

  assert.equal(authenticateToken('not-a-token-anyone-minted'), null);
});

/**
 * 🛑 A WRONG-LENGTH TOKEN MUST BE REFUSED, NOT THROW. This is the observable
 * proxy for the constant-time compare: `timingSafeEqual` throws on buffers of
 * unequal length, so an implementation that passed raw tokens to it would
 * raise here instead of returning null. Hashing first makes both sides a fixed
 * 32 bytes.
 */
test('🛑 a token of the WRONG LENGTH is refused, never thrown — the compare is over fixed-width digests', () => {
  const real = mintToken('tok-length');

  assert.equal(authenticateToken(''), null);
  assert.equal(authenticateToken('x'), null);
  assert.equal(authenticateToken(`${real}extra`), null);
  assert.equal(authenticateToken(real.slice(0, -1)), null);

  // The control: the untouched token still works, so the four above were
  // refused for being wrong rather than because nothing can authenticate.
  assert.equal(authenticateToken(real), 'tok-length');
});

/**
 * 🛑 THE FILE IS NOT A CREDENTIAL STORE. Anything that can read it must not be
 * able to authenticate with what it finds.
 *
 * 🛑 ASSERTS THE STORED VALUE **IS** THE DIGEST, NOT THAT THE TOKEN IS ABSENT
 * FROM THE TEXT. An earlier version only searched for the token string, and a
 * mutant storing `Buffer.from(token).toString('hex')` passed it — the raw token
 * was fully recoverable and did not appear literally. An equality cannot be
 * dodged by an encoding.
 */
test('🛑 the stored file holds NO token, only its SHA-256 — an encoding of the token does not pass', () => {
  const token = mintToken('tok-ondisk');
  const stored = (JSON.parse(readFileSync(handleTokensPath(), 'utf8')) as {
    handles: Record<string, string>;
  }).handles;

  assert.equal(stored['tok-ondisk'], createHash('sha256').update(token, 'utf8').digest('hex'));

  // Second layer, and the control for it: the handle IS in the text, so a
  // missing token is about the token rather than about an empty file.
  const raw = readFileSync(handleTokensPath(), 'utf8');

  assert.doesNotMatch(raw, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(raw, /tok-ondisk/);
});

test('the stored file is private to the operator', () => {
  mintToken('tok-mode');

  assert.equal(statSync(handleTokensPath()).mode & 0o777, 0o600);
});

/**
 * 🛑 RE-MINTING REPLACES, IT DOES NOT ADD. A container restart mints again, and
 * the token the previous process held must stop working.
 */
test('🛑 re-minting a handle INVALIDATES the token it had before', () => {
  const first = mintToken('tok-remint');
  const second = mintToken('tok-remint');

  assert.notEqual(first, second);
  assert.equal(authenticateToken(second), 'tok-remint');
  assert.equal(authenticateToken(first), null);
});

test('revoking a handle refuses its token and leaves every other handle working', () => {
  const doomed = mintToken('tok-doomed');
  const spared = mintToken('tok-spared');

  revokeToken('tok-doomed');

  assert.equal(authenticateToken(doomed), null);
  assert.equal(authenticateToken(spared), 'tok-spared');
});
