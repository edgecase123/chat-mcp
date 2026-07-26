import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { NotifyBus, notifyPeer } from '../../notify/bus.js';
import type { Db } from '../../storage/db.js';
import * as dao from '../../storage/dao.js';
import type { Message, MessageKind, AgentStatus, Agent } from '../../storage/dao.js';
import { assertRoomName } from '../../util/naming.js';
import type { View } from './views.js';
import { Header } from './panes/Header.js';

export interface AppProps {
  handle: string;
  db: Db;
  notify: NotifyBus;
  version: string;
}

interface Alert {
  id: number;
  from: string;
  to: string;
  body: string;
  ts: number;
}

function timeOf(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'green',
  thinking: 'yellow',
  tool: 'cyan',
  blocked: 'red',
  error: 'red',
  offline: 'gray',
};

const KIND_LABEL: Record<MessageKind, string | null> = {
  chat: null,
  dispatch: 'DISPATCH',
  alert: 'ALERT',
};

const KIND_COLOR: Record<MessageKind, string | undefined> = {
  chat: undefined,
  dispatch: 'cyan',
  alert: 'red',
};

/**
 * Ink POC — chat + agent coordination console. Two/three-pane layout:
 * sidebar (agents + rooms + optional watch peer) + main pane + optional
 * mirror pane + alert lane + input bar.
 */
export function App({ handle, db, notify, version }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<View>({ kind: 'home' });
  const [input, setInput] = useState('');
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [watchPeer, setWatchPeer] = useState<string | null>(null);

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
    if (view.kind === 'home' || view.kind === 'who' || view.kind === 'help' || view.kind === 'rooms') return [];
    if (view.kind === 'dm') {
      return db
        .prepare(
          `SELECT * FROM messages
           WHERE (from_handle = ? AND to_handle = ?)
              OR (from_handle = ? AND to_handle = ?)
           ORDER BY id DESC LIMIT 30`,
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
        `SELECT * FROM messages WHERE to_handle = ? ORDER BY id DESC LIMIT 30`,
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
         ORDER BY id DESC LIMIT 10`,
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
          setStatus(
            '/dm /join #x /leave /back /rooms /who /set-status <s> [focus...] /dispatch <peer> <text> /broadcast #room <text> /alert <target> <text> /watch <peer> /unwatch /ack /quit',
          );
          return;
        case 'back':
          setView({ kind: 'home' });
          return;
        case 'rooms':
          setView({ kind: 'home' });
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
      if (line.startsWith('/')) doCommand(line);
      else sendCurrent(line);
      setInput('');
    },
    [doCommand, sendCurrent],
  );

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') exit();
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

  return (
    <Box flexDirection="column" width="100%">
      <Header handle={handle} version={version} status={meStatus} focus={meFocus} />

      {/* Alert lane — only when there are unread alerts */}
      {alerts.length > 0 && (
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
          {alerts.map((a) => (
            <Text key={a.id}>
              <Text color="red" bold>
                🚨 ALERT
              </Text>{' '}
              <Text color="green" bold>
                {a.from}
              </Text>{' '}
              <Text dimColor>→ {a.to} · {timeOf(a.ts)}</Text>{' '}
              <Text>{a.body}</Text>
            </Text>
          ))}
          <Text dimColor>(/ack to dismiss)</Text>
        </Box>
      )}

      {/* Body: sidebar + main pane + optional watch pane */}
      <Box flexGrow={1}>
        <Sidebar
          handle={handle}
          view={view}
          peers={peers}
          rooms={rooms}
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
              watchMessages.map((m) => (
                <Box key={m.id} flexDirection="column">
                  <Text>
                    <Text bold color={m.from_handle === watchPeer ? 'green' : 'cyan'}>
                      {m.from_handle}
                    </Text>{' '}
                    <Text dimColor>→ {m.to_handle} · {timeOf(m.sent_at)}</Text>
                  </Text>
                  <Text>  {m.body}</Text>
                </Box>
              ))
            )}
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="cyan">{'> '}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>

      {status !== null && (
        <Box paddingX={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      )}
    </Box>
  );
}

interface SidebarProps {
  handle: string;
  view: View;
  peers: Agent[];
  rooms: ReturnType<typeof dao.myRooms>;
  dmUnreadByPeer: Map<string, number>;
  roomUnreadByName: Map<string, number>;
}

function Sidebar({
  view,
  peers,
  rooms,
  dmUnreadByPeer,
  roomUnreadByName,
}: SidebarProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width={30}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold color="magenta">
        AGENTS
      </Text>
      {peers.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        peers.map((p) => {
          const active = view.kind === 'dm' && view.peer === p.handle;
          const unread = dmUnreadByPeer.get(p.handle) ?? 0;
          const s = p.status;
          const dotColor = !p.online ? 'gray' : s ? STATUS_COLOR[s] : 'green';
          return (
            <Box key={p.handle} flexDirection="column">
              <Text>
                {active ? <Text color="cyan">▸ </Text> : <Text>  </Text>}
                <Text color={dotColor}>●</Text>{' '}
                <Text color={active ? 'cyan' : undefined} bold={active}>
                  {p.handle}
                </Text>
                {s && (
                  <>
                    {' '}
                    <Text dimColor>[{s}]</Text>
                  </>
                )}
                {unread > 0 && <Text color="yellow"> ({unread})</Text>}
              </Text>
              {p.focus && (
                <Text dimColor>    {p.focus}</Text>
              )}
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text bold color="magenta">
          ROOMS
        </Text>
      </Box>
      {rooms.length === 0 ? (
        <Text dimColor>(none — /join #x)</Text>
      ) : (
        rooms.map((r) => {
          const active = view.kind === 'room' && view.room === r.name;
          const unread = roomUnreadByName.get(r.name) ?? 0;
          return (
            <Text key={r.name}>
              {active ? <Text color="cyan">▸ </Text> : <Text>  </Text>}
              <Text color={active ? 'cyan' : undefined} bold={active}>
                {r.name}
              </Text>
              {unread > 0 && <Text color="yellow"> ({unread})</Text>}
            </Text>
          );
        })
      )}
    </Box>
  );
}

interface MessagesPaneProps {
  view: View;
  messages: Message[];
  meHandle: string;
}

function MessagesPane({ view, messages, meHandle }: MessagesPaneProps): React.ReactElement {
  const title =
    view.kind === 'home'
      ? '(select an agent or room)'
      : view.kind === 'dm'
        ? `dm · ${view.peer}`
        : view.kind === 'room'
          ? view.room
          : '';
  return (
    <>
      <Text bold color="cyan">
        {title}
      </Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {messages.length === 0 ? (
          <Text dimColor>{view.kind === 'home' ? '' : '(no messages)'}</Text>
        ) : (
          messages.map((m) => (
            <Box key={m.id} flexDirection="column" marginBottom={1}>
              <Text>
                <Text bold color={m.from_handle === meHandle ? 'cyan' : 'green'}>
                  {m.from_handle}
                </Text>{' '}
                <Text dimColor>{timeOf(m.sent_at)}</Text>
                {KIND_LABEL[m.kind] && (
                  <>
                    {' '}
                    <Text color={KIND_COLOR[m.kind]} bold>
                      [{KIND_LABEL[m.kind]}]
                    </Text>
                  </>
                )}
              </Text>
              <Text color={KIND_COLOR[m.kind]}>  {m.body}</Text>
            </Box>
          ))
        )}
      </Box>
    </>
  );
}

interface WhoPaneProps {
  peers: Agent[];
  meHandle: string;
}

interface Column {
  key: 'handle' | 'kind' | 'online' | 'status' | 'focus' | 'seen';
  label: string;
  width: number;
}

const WHO_COLUMNS: Column[] = [
  { key: 'handle', label: 'HANDLE', width: 14 },
  { key: 'kind', label: 'KIND', width: 8 },
  { key: 'online', label: 'ONLINE', width: 8 },
  { key: 'status', label: 'STATUS', width: 10 },
  { key: 'focus', label: 'FOCUS', width: 30 },
  { key: 'seen', label: 'SEEN', width: 10 },
];

function pad(v: string, n: number): string {
  if (v.length >= n) return v.slice(0, Math.max(0, n - 1)) + ' ';
  return v + ' '.repeat(n - v.length);
}

function WhoPane({ peers, meHandle }: WhoPaneProps): React.ReactElement {
  const totalWidth = WHO_COLUMNS.reduce((s, c) => s + c.width, 0);
  return (
    <>
      <Text bold color="cyan">
        who · {peers.length} peer{peers.length === 1 ? '' : 's'} (me: {meHandle})
      </Text>
      <Text dimColor>{'─'.repeat(Math.min(totalWidth, 80))}</Text>

      {/* header row */}
      <Box>
        {WHO_COLUMNS.map((c) => (
          <Text key={c.key} bold color="magenta">
            {pad(c.label, c.width)}
          </Text>
        ))}
      </Box>
      <Text dimColor>{'─'.repeat(Math.min(totalWidth, 80))}</Text>

      {peers.length === 0 ? (
        <Text dimColor>(no peers)</Text>
      ) : (
        peers.map((p) => {
          const s = p.status;
          const dotColor = !p.online ? 'gray' : s ? STATUS_COLOR[s] : 'green';
          return (
            <Box key={p.handle}>
              <Box width={WHO_COLUMNS[0]!.width}>
                <Text>
                  <Text color={dotColor}>●</Text>{' '}
                  <Text bold>{pad(p.handle, WHO_COLUMNS[0]!.width - 2)}</Text>
                </Text>
              </Box>
              <Text dimColor>{pad(p.kind, WHO_COLUMNS[1]!.width)}</Text>
              <Text color={p.online ? 'green' : 'gray'}>
                {pad(p.online ? 'yes' : 'no', WHO_COLUMNS[2]!.width)}
              </Text>
              <Text color={s ? STATUS_COLOR[s] : undefined}>
                {pad(s ?? '—', WHO_COLUMNS[3]!.width)}
              </Text>
              <Text>{pad(p.focus ?? '—', WHO_COLUMNS[4]!.width)}</Text>
              <Text dimColor>{pad(timeOf(p.last_seen_at), WHO_COLUMNS[5]!.width)}</Text>
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text dimColor>/back to close</Text>
      </Box>
    </>
  );
}
