import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Input } from './input/Input.js';
import { Autocomplete } from './input/Autocomplete.js';
import { getCompletions } from './input/completions.js';
import type { Completion } from './input/completions.js';
import { NotifyBus, notifyPeer } from '../../notify/bus.js';
import type { Db } from '../../storage/db.js';
import * as dao from '../../storage/dao.js';
import type { Message, MessageKind, AgentStatus, Agent } from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import type { View } from './views.js';
import { Header } from './panes/Header.js';
import { AlertLane } from './panes/AlertLane.js';
import type { Alert } from './panes/AlertLane.js';
import { MessagesPane } from './panes/MessagesPane.js';
import { ScrollableMessageList } from './panes/ScrollableMessageList.js';
import { WhoPane } from './panes/WhoPane.js';
import { HelpPane } from './panes/HelpPane.js';
import { KeyboardPane } from './panes/KeyboardPane.js';
import { RoomsBrowserPane } from './panes/RoomsBrowserPane.js';
import { Sidebar } from './panes/Sidebar.js';
import { Palette } from './palette/Palette.js';
import { HintBar } from './HintBar.js';
import { Markdown } from './util/markdown.js';
import { useMessageViewport } from './util/viewport.js';

export interface AppProps {
  handle: string;
  db: Db;
  notify: NotifyBus;
  version: string;
}

function timeOf(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

/**
 * Characters our global useInput handler claims when the input buffer is
 * empty. Input skips inserting these so they don't echo into the field.
 * Keep in sync with the empty-input branches of the global useInput below.
 */
const EMPTY_BUFFER_HOTKEYS = ['?', 'R', 'r', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * Ink POC — chat + agent coordination console. Two/three-pane layout:
 * sidebar (agents + rooms + optional watch peer) + main pane + optional
 * mirror pane + alert lane + input bar.
 */
export function App({ handle, db, notify, version }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<View>({ kind: 'home' });
  const [input, setInput] = useState<{ value: string; cursor: number }>({ value: '', cursor: 0 });
  const [completionIndex, setCompletionIndex] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [watchPeer, setWatchPeer] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ value: string; cursor: number } | null>(null);
  const messageViewport = useMessageViewport();

  useEffect(() => {
    const bump = (): void => setTick((t) => t + 1);
    notify.subscribe(bump);
    return () => {
      void notify.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rooms = useMemo(() => dao.myRooms(db, handle), [db, handle, tick]);
  const peers = useMemo<Agent[]>(
    () => dao.listAgents(db, true).filter((a) => a.handle !== handle),
    [db, handle, tick],
  );

  const messages = useMemo<Message[]>(() => {
    if (view.kind === 'home' || view.kind === 'who' || view.kind === 'help' || view.kind === 'keyboard' || view.kind === 'rooms') return [];
    if (view.kind === 'dm') {
      return db
        .prepare(
          `SELECT * FROM messages
           WHERE (from_handle = ? AND to_handle = ?)
              OR (from_handle = ? AND to_handle = ?)
           ORDER BY id DESC LIMIT 200`,
        )
        .all(handle, view.peer, view.peer, handle)
        .reverse()
        .map((r) => ({
          id: (r as { id: number }).id,
          from_handle: (r as { from_handle: string }).from_handle,
          to_handle: (r as { to_handle: string }).to_handle,
          body: (r as { body: string }).body,
          sent_at: (r as { sent_at: number }).sent_at,
          delivered_at: (r as { delivered_at: number | null }).delivered_at,
          read_at: (r as { read_at: number | null }).read_at,
          kind: ((r as { kind: string }).kind ?? 'chat') as MessageKind,
        }));
    }
    return db
      .prepare(
        `SELECT * FROM messages WHERE to_handle = ? ORDER BY id DESC LIMIT 200`,
      )
      .all(view.room)
      .reverse()
      .map((r) => ({
        id: (r as { id: number }).id,
        from_handle: (r as { from_handle: string }).from_handle,
        to_handle: (r as { to_handle: string }).to_handle,
        body: (r as { body: string }).body,
        sent_at: (r as { sent_at: number }).sent_at,
        delivered_at: (r as { delivered_at: number | null }).delivered_at,
        read_at: (r as { read_at: number | null }).read_at,
        kind: ((r as { kind: string }).kind ?? 'chat') as MessageKind,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, tick]);

  // Watched-peer mirror: last 10 messages TO or FROM them.
  const watchMessages = useMemo<Message[]>(() => {
    if (!watchPeer) return [];
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE from_handle = ? OR to_handle = ?
         ORDER BY id DESC LIMIT 100`,
      )
      .all(watchPeer, watchPeer)
      .reverse()
      .map((r) => ({
        id: (r as { id: number }).id,
        from_handle: (r as { from_handle: string }).from_handle,
        to_handle: (r as { to_handle: string }).to_handle,
        body: (r as { body: string }).body,
        sent_at: (r as { sent_at: number }).sent_at,
        delivered_at: (r as { delivered_at: number | null }).delivered_at,
        read_at: (r as { read_at: number | null }).read_at,
        kind: ((r as { kind: string }).kind ?? 'chat') as MessageKind,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchPeer, tick]);

  // Unread alerts across DMs + rooms I'm in. Rendered in the alert lane.
  const alerts = useMemo<Alert[]>(() => {
    const rows = db
      .prepare(
        `SELECT m.id, m.from_handle, m.to_handle, m.body, m.sent_at
         FROM messages m
         WHERE m.kind = 'alert'
           AND (
             (m.to_handle = ? AND m.read_at IS NULL)
             OR EXISTS (
               SELECT 1 FROM room_members rm
               LEFT JOIN room_reads rr ON rr.room_name = m.to_handle AND rr.handle = rm.handle
               WHERE rm.room_name = m.to_handle
                 AND rm.handle = ?
                 AND (rr.last_read_id IS NULL OR m.id > rr.last_read_id)
             )
           )
         ORDER BY m.id DESC LIMIT 5`,
      )
      .all(handle, handle) as unknown as Array<{
      id: number;
      from_handle: string;
      to_handle: string;
      body: string;
      sent_at: number;
    }>;
    return rows.reverse().map((r) => ({
      id: r.id,
      from: r.from_handle,
      to: r.to_handle,
      body: r.body,
      ts: r.sent_at,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, tick]);

  // Mark DMs read / advance room watermark when their view is open.
  useEffect(() => {
    if (view.kind === 'dm') {
      const unread = dao.pendingInbox(db, { to: handle });
      const fromPeer = unread.filter((m) => m.from_handle === view.peer);
      if (fromPeer.length > 0) {
        const ids = fromPeer.map((m) => m.id);
        dao.markRead(db, ids);
        dao.markDelivered(db, ids);
      }
    } else if (view.kind === 'room') {
      const unread = dao.allRoomsUnread(db, handle).filter((m) => m.to_handle === view.room);
      if (unread.length > 0) {
        const maxId = Math.max(...unread.map((m) => m.id));
        dao.advanceRoomRead(db, view.room, handle, maxId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, tick]);

  const dmUnreadByPeer = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of dao.pendingInbox(db, { to: handle })) {
      map.set(m.from_handle, (map.get(m.from_handle) ?? 0) + 1);
    }
    return map;
  }, [db, handle, tick]);

  const roomUnreadByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of dao.allRoomsUnread(db, handle)) {
      map.set(m.to_handle, (map.get(m.to_handle) ?? 0) + 1);
    }
    return map;
  }, [db, handle, tick]);

  const sendTo = useCallback(
    (target: { kind: 'dm'; peer: string } | { kind: 'room'; room: string }, body: string, kind: MessageKind) => {
      if (target.kind === 'dm') {
        if (!dao.getAgent(db, target.peer)) {
          setStatus(`peer ${target.peer} not registered`);
          return;
        }
        const sent = dao.insertMessage(db, { from: handle, to: target.peer, body, kind });
        notifyPeer(target.peer, { id: sent.id, to: target.peer, from: handle, ts: sent.sent_at });
      } else {
        if (!dao.isRoomMember(db, target.room, handle)) {
          setStatus(`not a member of ${target.room}`);
          return;
        }
        const sent = dao.insertMessage(db, { from: handle, to: target.room, body, kind });
        dao.advanceRoomRead(db, target.room, handle, sent.id);
        for (const member of dao.roomMembers(db, target.room)) {
          if (member === handle) continue;
          notifyPeer(member, { id: sent.id, to: target.room, from: handle, ts: sent.sent_at });
        }
      }
      setTick((t) => t + 1);
      setStatus(null);
    },
    [db, handle],
  );

  const sendCurrent = useCallback(
    (body: string, kind: MessageKind = 'chat') => {
      if (view.kind === 'dm') sendTo({ kind: 'dm', peer: view.peer }, body, kind);
      else if (view.kind === 'room') sendTo({ kind: 'room', room: view.room }, body, kind);
      else setStatus('open a conversation first (/dm or /join)');
    },
    [view, sendTo],
  );

  const doCommand = useCallback(
    (line: string) => {
      const parts = line.slice(1).trim().split(/\s+/);
      const cmd = parts[0] ?? '';
      const args = parts.slice(1);
      switch (cmd) {
        case 'quit':
        case 'exit':
          exit();
          return;
        case 'help':
          setView({ kind: 'help' });
          return;
        case 'keyboard':
          setView({ kind: 'keyboard' });
          return;
        case 'back':
          setView({ kind: 'home' });
          return;
        case 'rooms':
          setView({ kind: 'rooms' });
          return;
        case 'who':
          setView({ kind: 'who' });
          return;
        case 'dm': {
          const t = args[0];
          if (!t) return setStatus('usage: /dm <peer>');
          if (t === handle) return setStatus('cannot dm yourself');
          if (!dao.getAgent(db, t)) return setStatus(`unknown peer: ${t}`);
          setView({ kind: 'dm', peer: t });
          setStatus(null);
          return;
        }
        case 'join': {
          const name = args[0];
          if (!name) return setStatus('usage: /join #<room>');
          try {
            assertRoomName(name);
          } catch (e) {
            return setStatus((e as Error).message);
          }
          const result = dao.joinRoom(db, name, handle);
          if (result.was_new_member && result.system_message) {
            for (const member of dao.roomMembers(db, name)) {
              if (member === handle) continue;
              notifyPeer(member, {
                id: result.system_message.id,
                to: name,
                from: dao.SYSTEM_HANDLE,
                ts: result.system_message.sent_at,
              });
            }
          }
          setView({ kind: 'room', room: name });
          setStatus(null);
          setTick((t) => t + 1);
          return;
        }
        case 'leave': {
          if (view.kind !== 'room') return setStatus('not in a room');
          dao.leaveRoom(db, view.room, handle);
          setView({ kind: 'home' });
          setTick((t) => t + 1);
          return;
        }
        case 'set-status': {
          const [s, ...rest] = args;
          const allowed: AgentStatus[] = ['idle', 'thinking', 'tool', 'blocked', 'error', 'offline'];
          if (!s || !(allowed as string[]).includes(s)) {
            return setStatus(`usage: /set-status <${allowed.join('|')}> [focus...]`);
          }
          const focus = rest.length > 0 ? rest.join(' ') : null;
          dao.setAgentStatus(db, handle, s as AgentStatus, focus);
          setTick((t) => t + 1);
          setStatus(`status → ${s}${focus ? ` · ${focus}` : ''}`);
          return;
        }
        case 'dispatch': {
          const [to, ...rest] = args;
          if (!to || rest.length === 0) return setStatus('usage: /dispatch <peer> <text...>');
          if (!dao.getAgent(db, to)) return setStatus(`unknown peer: ${to}`);
          sendTo({ kind: 'dm', peer: to }, rest.join(' '), 'dispatch');
          setStatus(`dispatched → ${to}`);
          return;
        }
        case 'broadcast': {
          const [room, ...rest] = args;
          if (!room || rest.length === 0) return setStatus('usage: /broadcast #<room> <text...>');
          try {
            assertRoomName(room);
          } catch (e) {
            return setStatus((e as Error).message);
          }
          if (!dao.isRoomMember(db, room, handle)) {
            return setStatus(`not a member of ${room} — /join first`);
          }
          sendTo({ kind: 'room', room }, rest.join(' '), 'dispatch');
          setStatus(`broadcast → ${room}`);
          return;
        }
        case 'alert': {
          const [target, ...rest] = args;
          if (!target || rest.length === 0) return setStatus('usage: /alert <peer|#room> <text...>');
          const body = rest.join(' ');
          if (target.startsWith('#')) {
            try {
              assertRoomName(target);
            } catch (e) {
              return setStatus((e as Error).message);
            }
            if (!dao.isRoomMember(db, target, handle)) {
              return setStatus(`not a member of ${target} — /join first`);
            }
            sendTo({ kind: 'room', room: target }, body, 'alert');
            setStatus(`🚨 alert → ${target}`);
          } else {
            if (!dao.getAgent(db, target)) return setStatus(`unknown peer: ${target}`);
            sendTo({ kind: 'dm', peer: target }, body, 'alert');
            setStatus(`🚨 alert → ${target}`);
          }
          return;
        }
        case 'watch': {
          const [p] = args;
          if (!p) return setStatus('usage: /watch <peer>');
          if (p === handle) return setStatus('cannot watch yourself');
          if (!dao.getAgent(db, p)) return setStatus(`unknown peer: ${p}`);
          setWatchPeer(p);
          setStatus(`watching ${p}`);
          return;
        }
        case 'unwatch':
          setWatchPeer(null);
          setStatus('unwatched');
          return;
        case 'ack': {
          // Dismiss the alert lane by marking every visible alert read (DMs)
          // or advancing the room read watermark past them.
          for (const a of alerts) {
            if (a.to === handle) {
              dao.markRead(db, [a.id]);
              dao.markDelivered(db, [a.id]);
            } else {
              // Room alert: advance my read watermark past it.
              dao.advanceRoomRead(db, a.to, handle, a.id);
            }
          }
          setTick((t) => t + 1);
          setStatus('alerts dismissed');
          return;
        }
        default:
          setStatus(`unknown: /${cmd}`);
      }
    },
    [db, handle, view, exit, sendTo, alerts],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const line = value.trim();
      if (line.length === 0) return;
      setHistory((h) => {
        // Collapse consecutive duplicates + cap ring at 100.
        const last = h[h.length - 1];
        const next = last === line ? h : [...h, line];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
      setHistoryIndex(null);
      setDraft(null);
      if (line.startsWith('/')) doCommand(line);
      else sendCurrent(line);
    },
    [doCommand, sendCurrent],
  );

  const historyUp = useCallback(() => {
    if (history.length === 0) return;
    setHistoryIndex((i) => {
      if (i === null) {
        // First press: save the current draft, jump to newest history entry.
        setDraft({ value: input.value, cursor: input.cursor });
        const newest = history.length - 1;
        setInput({ value: history[newest]!, cursor: history[newest]!.length });
        return newest;
      }
      if (i === 0) return 0;
      const next = i - 1;
      setInput({ value: history[next]!, cursor: history[next]!.length });
      return next;
    });
  }, [history, input.value, input.cursor]);

  const historyDown = useCallback(() => {
    setHistoryIndex((i) => {
      if (i === null) return null;
      if (i >= history.length - 1) {
        const d = draft ?? { value: '', cursor: 0 };
        setInput(d);
        setDraft(null);
        return null;
      }
      const next = i + 1;
      setInput({ value: history[next]!, cursor: history[next]!.length });
      return next;
    });
  }, [history, draft]);

  useInput((raw, key) => {
    if (key.ctrl && raw === 'c') exit();
    if (key.ctrl && raw === 'k' && !paletteOpen) return setPaletteOpen(true);

    // Empty-input hotkeys — must not fire while palette is open.
    if (input.value.length > 0 || paletteOpen) return;
    if (raw === '?') return setView({ kind: 'help' });
    if (raw === 'R' || raw === 'r') return setView({ kind: 'rooms' });
    if (/^[1-9]$/.test(raw)) {
      const n = parseInt(raw, 10) - 1;
      // Order: peers first, then joined rooms, then discover rooms.
      const targets: Array<{ kind: 'dm'; peer: string } | { kind: 'room'; room: string; join?: boolean }> = [
        ...peers.map((p) => ({ kind: 'dm' as const, peer: p.handle })),
        ...rooms.map((r) => ({ kind: 'room' as const, room: r.name })),
        ...discoverRooms.map((r) => ({ kind: 'room' as const, room: r.name, join: true })),
      ];
      const t = targets[n];
      if (!t) return;
      if (t.kind === 'dm') {
        setView({ kind: 'dm', peer: t.peer });
      } else if (t.join) {
        const result = dao.joinRoom(db, t.room, handle);
        if (result.was_new_member && result.system_message) {
          for (const member of dao.roomMembers(db, t.room)) {
            if (member === handle) continue;
            notifyPeer(member, { id: result.system_message.id, to: t.room, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at });
          }
        }
        setView({ kind: 'room', room: t.room });
        setTick((tk) => tk + 1);
      } else {
        setView({ kind: 'room', room: t.room });
      }
    }
  });

  const showWatch = watchPeer !== null;
  const meStatus = useMemo(() => {
    const me = dao.getAgent(db, handle);
    return me?.status ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const meFocus = useMemo(() => {
    const me = dao.getAgent(db, handle);
    return me?.focus ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const allRoomsList = useMemo(() => dao.allRooms(db), [db, tick]);
  const discoverRooms = useMemo(
    () => allRoomsList.filter((r) => !rooms.some((mr) => mr.name === r.name) && r.member_count > 0),
    [allRoomsList, rooms],
  );

  const completions: Completion[] = useMemo(() => {
    return getCompletions(input.value, input.cursor, {
      me: handle,
      peers: peers.map((p) => p.handle),
      memberRooms: rooms.map((r) => r.name),
      discoverRooms: discoverRooms.map((r) => r.name),
    });
  }, [input.value, input.cursor, peers, rooms, discoverRooms, handle]);

  return (
    <Box flexDirection="column" width="100%">
      <Header handle={handle} version={version} status={meStatus} focus={meFocus} />

      <AlertLane alerts={alerts} />

      {paletteOpen && (
        <Palette
          onClose={() => setPaletteOpen(false)}
          onSelect={(cmd) => {
            setPaletteOpen(false);
            if (cmd.args.length === 0) {
              doCommand(cmd.name);
            } else {
              setInput({ value: cmd.name + ' ', cursor: cmd.name.length + 1 });
            }
          }}
        />
      )}

      {/* Body: sidebar + main pane + optional watch pane */}
      <Box flexGrow={1}>
        <Sidebar
          handle={handle}
          view={view}
          peers={peers}
          memberRooms={rooms}
          discoverRooms={discoverRooms}
          dmUnreadByPeer={dmUnreadByPeer}
          roomUnreadByName={roomUnreadByName}
        />

        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          {view.kind === 'who' ? (
            <WhoPane peers={peers} meHandle={handle} />
          ) : view.kind === 'help' ? (
            <HelpPane />
          ) : view.kind === 'keyboard' ? (
            <KeyboardPane />
          ) : view.kind === 'rooms' ? (
            <RoomsBrowserPane
              db={db}
              handle={handle}
              rooms={allRoomsList.filter((r) => r.member_count > 0)}
              onOpen={(room) => setView({ kind: 'room', room })}
              onJoin={(room) => {
                const result = dao.joinRoom(db, room, handle);
                if (result.was_new_member && result.system_message) {
                  for (const member of dao.roomMembers(db, room)) {
                    if (member === handle) continue;
                    notifyPeer(member, { id: result.system_message.id, to: room, from: dao.SYSTEM_HANDLE, ts: result.system_message.sent_at });
                  }
                }
                setView({ kind: 'room', room });
                setTick((t) => t + 1);
              }}
            />
          ) : (
            <MessagesPane view={view} messages={messages} meHandle={handle} />
          )}
        </Box>

        {showWatch && watchPeer && (
          <Box
            flexDirection="column"
            width={34}
            borderStyle="round"
            borderColor="magenta"
            paddingX={1}
          >
            <Text bold color="magenta">
              👁  WATCH: {watchPeer}
            </Text>
            <Text dimColor>{'─'.repeat(30)}</Text>
            {watchMessages.length === 0 ? (
              <Text dimColor>(no traffic)</Text>
            ) : (
              <ScrollableMessageList
                messages={watchMessages}
                meHandle={handle}
                viewportRows={messageViewport}
                focused={showWatch}
                requireShift={true}
                renderRow={(m) => (
                  <Box key={m.id} flexDirection="column">
                    <Text>
                      <Text bold color={m.from_handle === watchPeer ? 'green' : 'cyan'}>
                        {m.from_handle}
                      </Text>{' '}
                      <Text dimColor>→ {m.to_handle} · {timeOf(m.sent_at)}</Text>
                    </Text>
                    <Box paddingLeft={2}>
                      <Markdown body={m.body} />
                    </Box>
                  </Box>
                )}
              />
            )}
          </Box>
        )}
      </Box>

      <HintBar view={view} />

      {/* Input — hidden while palette is open so keys don't dispatch to both handlers */}
      {!paletteOpen && (
        <Box flexDirection="column">
          {completions.length > 0 && (
            <Autocomplete completions={completions} selectedIndex={completionIndex} />
          )}
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Input
              value={input.value}
              cursor={input.cursor}
              onChange={(value, cursor) => {
                setInput({ value, cursor });
                setCompletionIndex(0);
                if (historyIndex !== null) { setHistoryIndex(null); setDraft(null); }
              }}
              onSubmit={(v) => { handleSubmit(v); setInput({ value: '', cursor: 0 }); }}
              onTab={() => {
                // Tab-complete: replace current token with the selected completion + trailing space.
                const c = completions[completionIndex];
                if (!c) return;
                const before = input.value.slice(0, input.cursor);
                const after = input.value.slice(input.cursor);
                const tokenStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('#') - 1) + 1;
                const nextValue = input.value.slice(0, tokenStart) + c.value + ' ' + after;
                const nextCursor = tokenStart + c.value.length + 1;
                setInput({ value: nextValue, cursor: nextCursor });
                setCompletionIndex(0);
              }}
              onEsc={() => {
                if (completions.length > 0) { setInput({ value: '', cursor: 0 }); setCompletionIndex(0); }
              }}
              onUp={() => {
                if (completions.length > 0) return setCompletionIndex((i) => Math.max(0, i - 1));
                historyUp();
              }}
              onDown={() => {
                if (completions.length > 0) return setCompletionIndex((i) => Math.min(completions.length - 1, i + 1));
                historyDown();
              }}
              emptyBufferHotkeys={EMPTY_BUFFER_HOTKEYS}
            />
          </Box>
        </Box>
      )}

      {status !== null && (
        <Box paddingX={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      )}
    </Box>
  );
}


