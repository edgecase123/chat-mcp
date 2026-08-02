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

  // ─── Coordination: set_status → dispatch → alert ─────────────
  // 13. claude1 sets its status; claude2's list_agents sees it.
  {
    await c1.callTool({
      name: 'set_status',
      arguments: { status: 'tool', focus: 'running the gate' },
    });
    await sleep(50);
    const list = parseJson(await c2.callTool({ name: 'list_agents', arguments: {} }));
    const claude1 = list.find((a) => a.handle === 'claude1');
    if (claude1?.status === 'tool' && claude1?.focus === 'running the gate') {
      pass(13, 'set_status visible via list_agents');
    } else {
      fail(13, 'set_status projection', JSON.stringify(claude1));
    }
  }

  // 14. Dispatch: kind stamped on message.
  {
    await c1.callTool({
      name: 'send',
      arguments: { to: 'claude2', body: 'handle #1234', kind: 'dispatch' },
    });
    await sleep(50);
    const inbox = parseJson(await c2.callTool({ name: 'inbox', arguments: {} }));
    const disp = inbox.find((m) => m.body === 'handle #1234');
    if (disp?.kind === 'dispatch') {
      pass(14, 'send with kind=dispatch stamps message');
    } else {
      fail(14, 'dispatch kind', JSON.stringify(disp));
    }
  }

  // 15. Alert: kind stamped on message; surfaces to recipient inbox.
  {
    await c1.callTool({
      name: 'send',
      arguments: { to: 'claude2', body: 'GATE RED', kind: 'alert' },
    });
    await sleep(50);
    const inbox = parseJson(await c2.callTool({ name: 'inbox', arguments: {} }));
    const alert = inbox.find((m) => m.body === 'GATE RED');
    if (alert?.kind === 'alert') {
      pass(15, 'send with kind=alert stamps message');
    } else {
      fail(15, 'alert kind', JSON.stringify(alert));
    }
  }

  // ─── room_boot ──────────────────────────────────────────────
  // Setup: claude1 + claude2 join a fresh #kick room.
  {
    await c1.callTool({ name: 'room_join', arguments: { room: '#kick' } });
    await c2.callTool({ name: 'room_join', arguments: { room: '#kick' } });
    await sleep(50);

    // 16. Non-member cannot boot.
    {
      const r = await c1.callTool({ name: 'room_boot', arguments: { room: '#kick', handle: 'ghost' } });
      const msg = r.content?.[0]?.text ?? '';
      if (r.isError && msg.includes('not a member')) {
        pass(16, 'room_boot rejects target that is not a member');
      } else {
        fail(16, 'room_boot phantom handle', `isError=${r.isError} text=${msg}`);
      }
    }

    // 17. Cannot boot self.
    {
      const r = await c1.callTool({ name: 'room_boot', arguments: { room: '#kick', handle: 'claude1' } });
      const msg = r.content?.[0]?.text ?? '';
      if (r.isError && msg.includes('yourself')) {
        pass(17, 'room_boot rejects booting yourself');
      } else {
        fail(17, 'room_boot self', `isError=${r.isError} text=${msg}`);
      }
    }

    // 18. Happy path: claude1 boots claude2.
    const before = parseJson(await c1.callTool({
      name: 'room_members', arguments: { room: '#kick' },
    }));
    await c1.callTool({ name: 'room_boot', arguments: { room: '#kick', handle: 'claude2' } });
    await sleep(50);
    const after = parseJson(await c1.callTool({
      name: 'room_members', arguments: { room: '#kick' },
    }));
    if (before.includes('claude2') && !after.includes('claude2') && after.includes('claude1')) {
      pass(18, 'room_boot removes target from room_members');
    } else {
      fail(18, 'room_boot happy path',
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }
  }

  // ─── room_delete ────────────────────────────────────────────
  // 19. Non-member cannot delete.
  {
    const r = await c2.callTool({ name: 'room_delete', arguments: { room: '#kick' } });
    const msg = r.content?.[0]?.text ?? '';
    if (r.isError && msg.includes('not a member')) {
      pass(19, 'room_delete rejects non-member caller');
    } else {
      fail(19, 'room_delete by non-member', `isError=${r.isError} text=${msg}`);
    }
  }

  // 20. Member can delete; room disappears from allRooms.
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
      pass(20, 'room_delete removes room from roster');
    } else {
      fail(20, 'room_delete cleanup',
        `had=${hadKick} stillThere=${stillThere}`);
    }
  }

  // ─── context gauge (slice 1) ────────────────────────────────
  // 21. report_context writes → list_agents surfaces used/total.
  {
    await c1.callTool({
      name: 'report_context',
      arguments: { used: 137000, total: 1000000 },
    });
    await sleep(50);
    const list = parseJson(await c2.callTool({ name: 'list_agents', arguments: {} }));
    const claude1 = list.find((a) => a.handle === 'claude1');
    if (claude1?.context_used === 137000 && claude1?.context_total === 1000000
        && typeof claude1?.context_reported_at === 'number') {
      pass(21, 'report_context surfaces via list_agents');
    } else {
      fail(21, 'report_context projection', JSON.stringify(claude1));
    }
  }

  // 22. report_context rejects used > total.
  {
    const r = await c1.callTool({
      name: 'report_context',
      arguments: { used: 2000000, total: 1000000 },
    });
    const msg = r.content?.[0]?.text ?? '';
    if (r.isError && msg.includes('must not exceed')) {
      pass(22, 'report_context rejects used > total');
    } else {
      fail(22, 'report_context bounds check', `isError=${r.isError} text=${msg}`);
    }
  }

  // 23. Unreported peers surface as null gauge.
  {
    const me = parseJson(await c2.callTool({ name: 'whoami', arguments: {} }));
    if (me.context_used === null && me.context_total === null
        && me.context_reported_at === null) {
      pass(23, 'unreported gauge reads back as null');
    } else {
      fail(23, 'unreported null gauge',
        `used=${me.context_used} total=${me.context_total} at=${me.context_reported_at}`);
    }
  }

  // ─── context gauge (slice 2 — thresholds + hysteresis) ──────
  // Setup: both peers join #gauge so the room-post warnings have a target.
  {
    await c1.callTool({ name: 'room_join', arguments: { room: '#gauge' } });
    await c2.callTool({ name: 'room_join', arguments: { room: '#gauge' } });
    await sleep(50);
    // Drain any join announcements so later inbox reads are clean.
    await c1.callTool({ name: 'room_inbox', arguments: { room: '#gauge' } });
    await c2.callTool({ name: 'room_inbox', arguments: { room: '#gauge' } });
    await c1.callTool({ name: 'inbox', arguments: {} });
  }

  // 24. Cross 70% up → soft warning DM to reporter only (no room post).
  {
    // Reset warned state via a low report first (below 65% resets from any).
    await c1.callTool({ name: 'report_context', arguments: { used: 100000, total: 1000000 } });
    const r = parseJson(await c1.callTool({
      name: 'report_context', arguments: { used: 720000, total: 1000000 },
    }));
    await sleep(50);
    const dm = parseJson(await c1.callTool({ name: 'inbox', arguments: {} }));
    const soft = dm.find((m) => m.from === 'system' && m.body.includes('🟡'));
    const roomMsgs = parseJson(await c1.callTool({
      name: 'room_inbox', arguments: { room: '#gauge' },
    }));
    const roomWarn = roomMsgs.find((m) => m.from === 'system' && m.body.includes('🟡'));
    if (r.fired === 70 && soft && !roomWarn && r.notified.dm === 1) {
      pass(24, 'crossing 70% fires DM only');
    } else {
      fail(24, '70% band',
        `fired=${r.fired} dm=${!!soft} room=${!!roomWarn} notified=${JSON.stringify(r.notified)}`);
    }
  }

  // 25. Cross 85% up → room post visible to co-agent, no fresh DM.
  {
    const r = parseJson(await c1.callTool({
      name: 'report_context', arguments: { used: 870000, total: 1000000 },
    }));
    await sleep(50);
    const roomMsgs = parseJson(await c2.callTool({
      name: 'room_inbox', arguments: { room: '#gauge' },
    }));
    const orange = roomMsgs.find((m) => m.from === 'system' && m.body.includes('🟠') && m.body.includes('claude1'));
    if (r.fired === 85 && orange && orange.kind === 'chat') {
      pass(25, 'crossing 85% posts orange room warning');
    } else {
      fail(25, '85% band',
        `fired=${r.fired} orange=${!!orange} kind=${orange?.kind}`);
    }
  }

  // 26. Cross 95% up → room post with kind='alert'.
  {
    const r = parseJson(await c1.callTool({
      name: 'report_context', arguments: { used: 970000, total: 1000000 },
    }));
    await sleep(50);
    const roomMsgs = parseJson(await c2.callTool({
      name: 'room_inbox', arguments: { room: '#gauge' },
    }));
    const red = roomMsgs.find((m) => m.from === 'system' && m.body.includes('🔴'));
    if (r.fired === 95 && red && red.kind === 'alert') {
      pass(26, 'crossing 95% posts red alert-kind room warning');
    } else {
      fail(26, '95% band',
        `fired=${r.fired} red=${!!red} kind=${red?.kind}`);
    }
  }

  // 27. Sitting inside a band on repeat report does not re-fire.
  {
    const r = parseJson(await c1.callTool({
      name: 'report_context', arguments: { used: 975000, total: 1000000 },
    }));
    if (r.fired === null && r.warned === 95) {
      pass(27, 'repeat report inside band does not re-fire');
    } else {
      fail(27, 'no-op re-report', `fired=${r.fired} warned=${r.warned}`);
    }
  }

  // 28. Dropping below hysteresis step-downs one band without firing.
  {
    // 95→85: drop below 90 puts us at warned=85, no fire.
    const step1 = parseJson(await c1.callTool({
      name: 'report_context', arguments: { used: 880000, total: 1000000 },
    }));
    // 85→70: drop below 80 puts us at warned=70, no fire.
    const step2 = parseJson(await c1.callTool({
      name: 'report_context', arguments: { used: 780000, total: 1000000 },
    }));
    if (step1.fired === null && step1.warned === 85
        && step2.fired === null && step2.warned === 70) {
      pass(28, 'hysteresis down-shifts silently one band at a time');
    } else {
      fail(28, 'hysteresis step-down',
        `s1(fired=${step1.fired} warned=${step1.warned}) s2(fired=${step2.fired} warned=${step2.warned})`);
    }
  }

  // 29. Re-crossing a band that was down-shifted re-fires.
  {
    // Currently warned=70, at 78%. Push back over 85 → 85 re-fires.
    const r = parseJson(await c1.callTool({
      name: 'report_context', arguments: { used: 870000, total: 1000000 },
    }));
    if (r.fired === 85 && r.warned === 85) {
      pass(29, 're-crossing a band re-fires its warning');
    } else {
      fail(29, 're-fire on re-cross', `fired=${r.fired} warned=${r.warned}`);
    }
  }

  // 30. Straight jump from clean to critical fires ONLY 95 (highest crossed).
  {
    // Reset to clean.
    await c1.callTool({ name: 'report_context', arguments: { used: 50000, total: 1000000 } });
    const r = parseJson(await c1.callTool({
      name: 'report_context', arguments: { used: 960000, total: 1000000 },
    }));
    if (r.fired === 95 && r.warned === 95) {
      pass(30, 'jump to critical fires only the highest band crossed');
    } else {
      fail(30, 'jump to 95', `fired=${r.fired} warned=${r.warned}`);
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
