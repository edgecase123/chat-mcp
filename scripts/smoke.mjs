#!/usr/bin/env node
// Walk the slice-1 acceptance criteria end-to-end.
// Spawns two MCP shims (claude1, claude2) via the SDK client, one CLI
// subprocess (user), exercises the 8 criteria, prints pass/fail per step,
// exits non-zero on any failure.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const ENTRY = join(REPO, 'dist', 'index.js');

const TMP = mkdtempSync(join(tmpdir(), 'chat-mcp-smoke-'));
const env = { ...process.env, CHAT_MCP_HOME: TMP };

const results = [];
const pass = (n, desc) => { results.push({ n, ok: true, desc }); console.log(`  ✓ ${n}. ${desc}`); };
const fail = (n, desc, why) => { results.push({ n, ok: false, desc, why }); console.log(`  ✗ ${n}. ${desc} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectShim(handle) {
  const client = new Client({ name: `smoke-${handle}`, version: '0.0.1' });
  await client.connect(new StdioClientTransport({
    command: 'node',
    args: [ENTRY, '--handle', handle],
    env,
  }));
  return client;
}

function spawnCli(handle) {
  const proc = spawn('node', [ENTRY, 'cli', '--handle', handle], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  const send = (line) => new Promise((r) => proc.stdin.write(line + '\n', () => setTimeout(r, 150)));
  return {
    proc,
    getOutput: () => out,
    resetOutput: () => { out = ''; },
    send,
    close: async () => {
      proc.kill();
      await new Promise((r) => proc.on('exit', r));
    },
  };
}

function parseJson(callToolResult) {
  const text = callToolResult.content?.[0]?.text ?? '';
  return JSON.parse(text);
}

let c1, c2, cli;
try {
  console.log(`smoke test in ${TMP}\n`);

  c1 = await connectShim('claude1');
  c2 = await connectShim('claude2');
  cli = spawnCli('user');
  await sleep(500); // let CLI boot + register

  // ─── Agent ↔ agent ───────────────────────────────────────────
  // 1. Who's online? (from claude1) → sees claude2 and user
  {
    const w = parseJson(await c1.callTool({ name: 'whoami', arguments: {} }));
    const peers = new Set(w.online_peers.map((p) => p.handle));
    if (peers.has('claude2') && peers.has('user')) {
      pass(1, 'claude1 sees claude2 + user in whoami.online_peers');
    } else {
      fail(1, 'claude1 whoami.online_peers', `got [${[...peers].join(', ')}]`);
    }
  }

  // 2. claude1 sends to claude2 → send succeeds
  let msg2Id;
  {
    const s = parseJson(await c1.callTool({ name: 'send', arguments: { to: 'claude2', body: 'hi' } }));
    if (typeof s.message_id === 'number' && s.message_id > 0) {
      msg2Id = s.message_id;
      pass(2, `claude1.send(claude2, "hi") → message_id=${msg2Id}`);
    } else {
      fail(2, 'claude1.send returned', JSON.stringify(s));
    }
  }

  // 3. claude2 inbox() sees the message
  {
    await sleep(50);
    const inbox = parseJson(await c2.callTool({ name: 'inbox', arguments: {} }));
    if (inbox.length >= 1 && inbox.some((m) => m.body === 'hi' && m.from === 'claude1')) {
      pass(3, 'claude2.inbox() returns the message from claude1');
    } else {
      fail(3, 'claude2.inbox()', JSON.stringify(inbox));
    }
  }

  // 4. claude2 wait_for_message; claude1 sends; returns in <1s
  {
    const t0 = Date.now();
    const waitP = c2.callTool({ name: 'wait_for_message', arguments: { timeout_s: 5 } });
    await sleep(200);
    await c1.callTool({ name: 'send', arguments: { to: 'claude2', body: 'ping via wait' } });
    const w = parseJson(await waitP);
    const elapsed = Date.now() - t0;
    if (w.length >= 1 && w.some((m) => m.body === 'ping via wait') && elapsed < 1500) {
      pass(4, `claude2.wait_for_message resolved in ${elapsed}ms with the message`);
    } else {
      fail(4, `claude2.wait_for_message elapsed=${elapsed}ms`, JSON.stringify(w));
    }
  }

  // ─── User CLI ↔ agent ────────────────────────────────────────
  // 5. /list shows claude1 + claude2
  {
    cli.resetOutput();
    await cli.send('/list');
    await sleep(200);
    const out = cli.getOutput();
    if (out.includes('claude1') && out.includes('claude2')) {
      pass(5, '/list in CLI shows claude1 + claude2');
    } else {
      fail(5, '/list output', JSON.stringify(out));
    }
  }

  // 6. /dm claude1 + type "ping" → claude1 sees it
  {
    cli.resetOutput();
    await cli.send('/dm claude1');
    await cli.send('ping from user');
    await sleep(200);
    const inbox = parseJson(await c1.callTool({ name: 'inbox', arguments: {} }));
    if (inbox.some((m) => m.body === 'ping from user' && m.from === 'user')) {
      pass(6, 'CLI /dm claude1 + "ping" → claude1.inbox() sees it');
    } else {
      fail(6, 'claude1.inbox after CLI ping', JSON.stringify(inbox));
    }
  }

  // 7. claude1 replies to user → CLI prints inline within ~1s (no user input needed)
  {
    cli.resetOutput();
    await c1.callTool({ name: 'send', arguments: { to: 'user', body: 'reply from claude1' } });
    // No CLI input — the notify subscription should print it inline
    await sleep(700);
    const out = cli.getOutput();
    if (out.includes('reply from claude1') && out.includes('claude1')) {
      pass(7, 'CLI prints incoming reply inline without user input');
    } else {
      fail(7, 'CLI output after reply', JSON.stringify(out));
    }
  }

  // 8. /back then /dm claude2 → same round-trip works
  {
    cli.resetOutput();
    await cli.send('/back');
    await cli.send('/dm claude2');
    await cli.send('hello claude2');
    await sleep(200);
    const inbox = parseJson(await c2.callTool({ name: 'inbox', arguments: {} }));
    if (inbox.some((m) => m.body === 'hello claude2' && m.from === 'user')) {
      pass(8, '/back then /dm claude2 + text → claude2.inbox() sees it');
    } else {
      fail(8, 'claude2.inbox after CLI /dm claude2', JSON.stringify(inbox));
    }
  }

  // ─── Room join announcement ─────────────────────────────────
  // 9. claude1 joins #announce (empty room, no announcement expected in
  //    their own inbox — nobody else was there); claude2 then joins,
  //    which posts "claude2 joined #announce". claude1 sees it in
  //    room_inbox; claude2 does not (watermark anchored past it).
  {
    await c1.callTool({ name: 'room_join', arguments: { room: '#announce' } });
    await sleep(50);
    // Drain any messages claude1 might already have watermarked past.
    await c1.callTool({ name: 'room_inbox', arguments: { room: '#announce' } });

    await c2.callTool({ name: 'room_join', arguments: { room: '#announce' } });
    await sleep(50);

    const c1Inbox = parseJson(await c1.callTool({
      name: 'room_inbox', arguments: { room: '#announce' },
    }));
    const c2Inbox = parseJson(await c2.callTool({
      name: 'room_inbox', arguments: { room: '#announce' },
    }));

    const c1Saw = c1Inbox.some(
      (m) => m.from === 'system' && m.body === 'claude2 joined #announce',
    );
    const c2Saw = c2Inbox.some(
      (m) => m.from === 'system' && m.body === 'claude2 joined #announce',
    );

    if (c1Saw && !c2Saw) {
      pass(9, 'room_join announcement: existing member sees system msg, joiner does not');
    } else {
      fail(9, 'room_join announcement',
        `c1Saw=${c1Saw} c2Saw=${c2Saw} c1=${JSON.stringify(c1Inbox)} c2=${JSON.stringify(c2Inbox)}`);
    }
  }

  // 10. Idempotent re-join does NOT post a second announcement.
  {
    // Drain claude1's inbox first.
    await c1.callTool({ name: 'room_inbox', arguments: { room: '#announce' } });

    await c2.callTool({ name: 'room_join', arguments: { room: '#announce' } });
    await sleep(50);

    const c1Inbox = parseJson(await c1.callTool({
      name: 'room_inbox', arguments: { room: '#announce' },
    }));
    const reAnnounced = c1Inbox.some(
      (m) => m.from === 'system' && m.body === 'claude2 joined #announce',
    );

    if (!reAnnounced) {
      pass(10, 'idempotent room_join does not re-announce');
    } else {
      fail(10, 'idempotent room_join re-announced', JSON.stringify(c1Inbox));
    }
  }

  // ─── room_members ───────────────────────────────────────────
  // 11. #announce now has claude1 + claude2 as members (from tests 9-10).
  //     room_members should return both handles in join order.
  {
    const members = parseJson(await c1.callTool({
      name: 'room_members', arguments: { room: '#announce' },
    }));
    if (Array.isArray(members) && members.length === 2 &&
        members[0] === 'claude1' && members[1] === 'claude2') {
      pass(11, 'room_members lists both peers in join order');
    } else {
      fail(11, 'room_members #announce', JSON.stringify(members));
    }
  }

  // 12. Unknown room → empty array, not an error.
  {
    const members = parseJson(await c1.callTool({
      name: 'room_members', arguments: { room: '#nonexistent' },
    }));
    if (Array.isArray(members) && members.length === 0) {
      pass(12, 'room_members on unknown room returns []');
    } else {
      fail(12, 'room_members #nonexistent', JSON.stringify(members));
    }
  }

  // ─── room_boot ──────────────────────────────────────────────
  // Setup: claude1 + claude2 join a fresh #kick room.
  {
    await c1.callTool({ name: 'room_join', arguments: { room: '#kick' } });
    await c2.callTool({ name: 'room_join', arguments: { room: '#kick' } });
    await sleep(50);

    // 13. Non-member cannot boot.
    {
      const r = await c1.callTool({ name: 'room_boot', arguments: { room: '#kick', handle: 'ghost' } });
      const msg = r.content?.[0]?.text ?? '';
      if (r.isError && msg.includes('not a member')) {
        pass(13, 'room_boot rejects target that is not a member');
      } else {
        fail(13, 'room_boot phantom handle', `isError=${r.isError} text=${msg}`);
      }
    }

    // 14. Cannot boot self.
    {
      const r = await c1.callTool({ name: 'room_boot', arguments: { room: '#kick', handle: 'claude1' } });
      const msg = r.content?.[0]?.text ?? '';
      if (r.isError && msg.includes('yourself')) {
        pass(14, 'room_boot rejects booting yourself');
      } else {
        fail(14, 'room_boot self', `isError=${r.isError} text=${msg}`);
      }
    }

    // 15. Happy path: claude1 boots claude2.
    const before = parseJson(await c1.callTool({
      name: 'room_members', arguments: { room: '#kick' },
    }));
    await c1.callTool({ name: 'room_boot', arguments: { room: '#kick', handle: 'claude2' } });
    await sleep(50);
    const after = parseJson(await c1.callTool({
      name: 'room_members', arguments: { room: '#kick' },
    }));
    if (before.includes('claude2') && !after.includes('claude2') && after.includes('claude1')) {
      pass(15, 'room_boot removes target from room_members');
    } else {
      fail(15, 'room_boot happy path',
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }
  }

  // ─── room_delete ────────────────────────────────────────────
  // 16. Non-member cannot delete.
  {
    const r = await c2.callTool({ name: 'room_delete', arguments: { room: '#kick' } });
    const msg = r.content?.[0]?.text ?? '';
    if (r.isError && msg.includes('not a member')) {
      pass(16, 'room_delete rejects non-member caller');
    } else {
      fail(16, 'room_delete by non-member', `isError=${r.isError} text=${msg}`);
    }
  }

  // 17. Member can delete; room disappears from allRooms.
  {
    const roomsBefore = parseJson(await c1.callTool({
      name: 'room_list', arguments: { include_all: true },
    }));
    const hadKick = roomsBefore.some((r) => r.name === '#kick');
    await c1.callTool({ name: 'room_delete', arguments: { room: '#kick' } });
    const roomsAfter = parseJson(await c1.callTool({
      name: 'room_list', arguments: { include_all: true },
    }));
    const stillThere = roomsAfter.some((r) => r.name === '#kick');
    if (hadKick && !stillThere) {
      pass(17, 'room_delete removes room from roster');
    } else {
      fail(17, 'room_delete cleanup',
        `had=${hadKick} stillThere=${stillThere}`);
    }
  }

} finally {
  if (cli) await cli.close();
  if (c1) await c1.close().catch(() => {});
  if (c2) await c2.close().catch(() => {});
  rmSync(TMP, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
