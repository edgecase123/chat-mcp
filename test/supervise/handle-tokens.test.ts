import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-handle-tokens-'));

const { mintToken, authenticateToken, revokeToken, handleTokenPathFor, handleTokensDir } =
  await import('../../src/supervise/handle-tokens.js');

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
  const raw = readFileSync(handleTokenPathFor('tok-ondisk'), 'utf8');
  const stored = (JSON.parse(raw) as { digest: string }).digest;

  assert.equal(stored, createHash('sha256').update(token, 'utf8').digest('hex'));

  // Second layer, and its control: the digest IS in the text, so a missing
  // token is about the token rather than about reading an empty file.
  assert.doesNotMatch(raw, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(raw, new RegExp(stored));
});

test('the stored file is private to the operator, and so is its directory', () => {
  mintToken('tok-mode');

  assert.equal(statSync(handleTokenPathFor('tok-mode')).mode & 0o777, 0o600);
  assert.equal(statSync(handleTokensDir()).mode & 0o777, 0o700);
});

/**
 * 🛑 THE HANDLE BECOMES A FILENAME. `__proto__` previously returned a token and
 * stored NOTHING — assigning it into a `JSON.parse` object hit the inherited
 * setter, so the caller held a credential for nobody. Found by claude2.
 */
test('🛑 a handle that is not a legal handle is REFUSED, not minted for', () => {
  for (const bad of ['__proto__', '../escape', 'has/slash', '', '#room', '_leading']) {
    assert.throws(() => mintToken(bad), /Invalid handle/, `mintToken accepted ${JSON.stringify(bad)}`);
  }

  // The control: a legal handle still mints, so the throws above are about the
  // names and not about minting being broken.
  assert.equal(authenticateToken(mintToken('tok-legal')), 'tok-legal');
});

/**
 * 🛑 `constructor` IS A LEGAL HANDLE AND MUST WORK. `__proto__` is refused for
 * starting with `_`, not for being a prototype key, so banning prototype names
 * was never the fix — one file per handle is. This is the test that says so.
 *
 * `toString` is refused, and ONLY because of its capital S. It is the paired
 * control for the handle case rule, not evidence that prototype keys are
 * special-cased — see `🛑 a handle carrying a CAPITAL is refused`.
 */
test('🛑 a handle that collides with an Object prototype key still authenticates', () => {
  assert.equal(authenticateToken(mintToken('constructor')), 'constructor');

  assert.throws(() => mintToken('toString'), /Invalid handle/);
  assert.equal(authenticateToken(mintToken('tostring')), 'tostring');
});

/**
 * 🛑 THE DETERMINISTIC PROOF THAT THE SCAN DOES NOT RETURN EARLY, claude2's
 * construction. Two handles holding one digest: a full scan sees both and
 * refuses, an early return answers whichever it met first.
 *
 * 🛑 REFUSING IS THE BEHAVIOUR, NOT A SIDE EFFECT. Guessing which of two
 * handles a caller is would be the one thing this function must never do.
 */
test('🛑 TWO handles sharing one digest are BOTH refused, which an early return could not do', () => {
  const token = mintToken('tok-twin-a');
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');

  // Written directly — minting cannot produce a collision.
  writeFileSync(handleTokenPathFor('tok-twin-b'), JSON.stringify({ digest }));

  assert.equal(authenticateToken(token), null);

  // The control: removing the twin restores the single answer, so the refusal
  // above was the ambiguity and not a broken scan.
  revokeToken('tok-twin-b');

  assert.equal(authenticateToken(token), 'tok-twin-a');
});

/**
 * 🛑 A MALFORMED DIGEST THROWS. A non-hex value decodes to a ZERO-LENGTH
 * buffer, so the length guard skipped it and that handle stopped
 * authenticating forever with no signal. Found by claude2.
 */
test('🛑 a digest that is not hex THROWS and names its file, rather than silently never matching', () => {
  const token = mintToken('tok-corrupt-neighbour');

  writeFileSync(handleTokenPathFor('tok-corrupt'), JSON.stringify({ digest: 'zzzz-not-hex' }));

  assert.throws(() => authenticateToken(token), /tok-corrupt\.json/);

  // The control: with the corrupt file gone the neighbour authenticates, so
  // the throw was the file and not the token.
  revokeToken('tok-corrupt');

  assert.equal(authenticateToken(token), 'tok-corrupt-neighbour');
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

/**
 * 🛑 THE BLOCKER claude2 MEASURED ON `ce5c91f`: four concurrent mints, one
 * token silently discarded. Read-modify-write on one shared file.
 *
 * Real child processes, because the race is between PROCESSES — two agents
 * being spawned at once is the production case, and nothing in one event loop
 * reproduces it.
 */
test('🛑 CONCURRENT mints of DISTINCT handles all keep working, so no token is handed out dead', async () => {
  const handles = ['conc-alpha', 'conc-beta', 'conc-gamma', 'conc-delta'];
  const root = resolve(import.meta.dirname, '../..');
  const child = join(root, 'test/fixtures/mint-one.mts');

  const tokens = await Promise.all(
    handles.map(
      (handle) =>
        new Promise<string>((ok, bad) => {
          execFile(
            process.execPath,
            ['--import', 'tsx', child, handle, root],
            { env: { ...process.env } },
            (err, stdout) => (err ? bad(err) : ok(stdout.trim())),
          );
        }),
    ),
  );

  assert.equal(new Set(tokens).size, handles.length, 'a handle was handed a duplicate token');

  // 🛑 EVERY ONE, NOT "most". One lost write is the whole finding.
  for (const [i, handle] of handles.entries()) {
    assert.equal(authenticateToken(tokens[i] as string), handle, `${handle}'s token is dead`);
  }
});

/**
 * 🛑 ONE CORRUPT FILE STOPS EVERY HANDLE, NOT JUST ITS OWN. `authenticateToken`
 * scans the whole directory, so the throw that makes a malformed digest visible
 * is a total outage rather than a one-handle one. claude2 raised that the
 * docblock claimed the narrower consequence.
 *
 * 🛑 THROWING IS STILL THE RIGHT CALL. The alternative is the silent death this
 * guard was added to end. The point of this test is that the blast radius is
 * recorded rather than discovered during an incident.
 */
test('🛑 a corrupt token file stops EVERY handle authenticating, which is the cost of the throw', () => {
  const healthy = mintToken('tok-healthy');

  assert.equal(authenticateToken(healthy), 'tok-healthy');

  // A sibling file nothing minted. Both shapes reach the same outage.
  for (const junk of ['{"digest":"not-hex"}', 'this is not json at all']) {
    writeFileSync(handleTokenPathFor('tok-broken'), junk);

    assert.throws(
      () => authenticateToken(healthy),
      /tok-broken\.json/,
      `a file holding ${JSON.stringify(junk)} did not name itself in the error`,
    );
  }

  // THE CONTROL. Removing the one bad file restores every other handle, so the
  // outage above was that file and not a store that had broken for good.
  revokeToken('tok-broken');

  assert.equal(authenticateToken(healthy), 'tok-healthy');
});
