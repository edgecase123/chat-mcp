import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';
import { route, type RouteContext } from '../../src/cli/web/server.js';
import { packageVersion } from '../../src/util/version.js';

const ROOT = new URL('../../', import.meta.url).pathname;

/** Walked, not globbed, so a new file is covered the day it lands. */
const SCAN_ROOTS = ['src', 'scripts'];

/**
 * 🛑 CARVED OUT BY CAUSE, NOT BY FILENAME: this literal is the SMOKE CLIENT's
 * own identity in the MCP handshake, so it is a different program's version
 * and tracking chat-mcp's would be wrong. The test below asserts the hit is
 * still there, so the carve-out cannot outlive its reason.
 */
const ALLOWED = new Map([['scripts/smoke.mjs', "version: '0.0.1'"]]);

function declaredVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');

  return (JSON.parse(raw) as { version: string }).version;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.(ts|mjs|js)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

/**
 * A version literal in a reporting position: an assignment, a property, a
 * positional argument, or a `v`-prefixed string. Not a bare `\d+\.\d+\.\d+`,
 * which also matches the first three octets of an IPv4 address.
 *
 * The positional alternative exists because `.version('0.0.1')` is the shape
 * the CLI entry point actually had, and a `[:=]`-only pattern misses it.
 */
const SEMVER_LITERAL = String.raw`['"\`]v?\d+\.\d+\.\d+[-.\w]*['"\`]`;
const HARDCODED = new RegExp(
  `(?:\\bVERSION\\s*[:=]|\\bversion\\s*[:=]|\\.?\\bversion\\(\\s*)\\s*${SEMVER_LITERAL}` +
    `|['"\`]v\\d+\\.\\d+\\.\\d+[-.\\w]*['"\`]`,
  'g',
);

test('packageVersion() returns what package.json declares', () => {
  assert.equal(packageVersion(), declaredVersion());
  assert.notEqual(packageVersion(), '0.0.0-unknown');
});

/**
 * 🛑 THE SCANNER PROVES ITSELF BEFORE IT CLEARS THE TREE. A regex that matches
 * nothing and a tree that hardcodes nothing produce the same green, and the
 * three stale banners this guard exists for were found by hand.
 */
test('the drift scanner catches the shapes it is looking for', () => {
  const bad = [
    "const VERSION = '0.3.0';",
    "{ name: 'chat-mcp', version: '0.4.4' },",
    "`${dim('v0.3.0')}`",
    // 🛑 A POSITIONAL ARGUMENT. The `[:=]`-only pattern cleared this shape.
    ".version('0.3.0');",
    "React.createElement(Header, { handle: 'me', version: '0.3.0' })",
  ];
  for (const sample of bad) {
    assert.match(sample, new RegExp(HARDCODED.source), `missed: ${sample}`);
  }
  // Must NOT fire on an IPv4 address or on the fallback sentinel.
  assert.doesNotMatch("server.listen(port, '127.0.0.1')", new RegExp(HARDCODED.source));
  assert.doesNotMatch(".version ?? '0.0.0-unknown'", new RegExp(HARDCODED.source));
});

test('no source file hardcodes a version — every surface reads package.json', () => {
  const files = SCAN_ROOTS.flatMap((r) => sourceFiles(join(ROOT, r)));
  // Denominator: a walk that silently matched nothing would otherwise pass.
  assert.ok(files.length >= 70, `scanned only ${files.length} files across ${SCAN_ROOTS}`);

  const hits: string[] = [];
  const allowedSeen = new Set<string>();
  let callers = 0;
  for (const f of files) {
    const rel = f.slice(ROOT.length);
    const text = readFileSync(f, 'utf8');
    if (text.includes('packageVersion(')) callers += 1;
    for (const m of text.matchAll(HARDCODED)) {
      if (ALLOWED.get(rel) === m[0]) {
        allowedSeen.add(rel);
        continue;
      }
      hits.push(`${rel}: ${m[0]}`);
    }
  }

  // The scanner read real content, not empty strings.
  assert.ok(callers >= 8, `only ${callers} of ${files.length} files call packageVersion()`);
  // A carve-out whose hit has gone needs its reason re-examined, not keeping.
  assert.deepEqual(
    [...allowedSeen].sort(),
    [...ALLOWED.keys()].sort(),
    'an ALLOWED literal no longer exists — delete the carve-out',
  );
  assert.deepEqual(hits, [], `hardcoded version in ${hits.length} of ${files.length} files`);
});

test('the browser UI reports the package version', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  dao.upsertAgent(db, {
    handle: 'operator',
    pid: 1,
    session_id: 'operator',
    display_name: 'operator',
    metadata: {},
  });
  const ctx: RouteContext = { handle: 'operator', db, sseClients: new Set(), port: 0 };
  const server: Server = createServer((req, res) => {
    void route(req, res, ctx);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  ctx.port = port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/whoami`);
    const body = (await res.json()) as { version?: string };
    assert.equal(res.status, 200);
    assert.equal(body.version, declaredVersion());
  } finally {
    server.closeAllConnections();
    server.close();
    db.close();
  }
});
