import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-handle-filename-'));

const { adapterScriptPath, manifestPathFor, mcpConfigPathFor, notifyPathFor, socketPathFor } =
  await import('../../src/util/paths.js');

/**
 * 🛑 NARROWING `HANDLE_RE` ONLY REACHES A PATH THAT CALLS THE VALIDATOR, and
 * four of these five did not. macOS APFS is case-insensitive, so an unvalidated
 * `Alice` lands on `alice`'s notify file, socket or MCP config. Found by
 * claude2 while reviewing the regex change.
 *
 * The consequence is not identity here — only the token store hands back a
 * handle. It is a wake delivered to the wrong agent, which reads as that agent
 * ignoring its messages.
 */
const BUILDERS: ReadonlyArray<readonly [string, (handle: string) => string]> = [
  ['notifyPathFor', notifyPathFor],
  ['socketPathFor', socketPathFor],
  ['mcpConfigPathFor', mcpConfigPathFor],
  ['manifestPathFor', manifestPathFor],
  ['adapterScriptPath', (handle) => adapterScriptPath('claude-code', handle)],
];

test('🛑 EVERY path builder that makes a handle into a filename REFUSES an illegal handle', () => {
  for (const [name, build] of BUILDERS) {
    for (const bad of ['Alice', '../escape', 'has/slash', '_leading', '']) {
      assert.throws(
        () => build(bad),
        /Invalid handle/,
        `${name} accepted ${JSON.stringify(bad)}`,
      );
    }
  }
});

/**
 * 🛑 THE PAIRED CONTROL. "Every builder throws" passes for a builder that
 * throws on everything, so the accepting half ships beside it.
 */
test('every path builder still accepts a legal handle and puts it in the path', () => {
  for (const [name, build] of BUILDERS) {
    const path = build('claude1');

    assert.match(path, /claude1/, `${name} dropped the handle from its path`);
  }
});
