import React from 'react';
import { Box, Text } from 'ink';
import type { Agent, AgentStatus, Room } from '../../../storage/dao.js';
import type { View } from '../views.js';

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'green',
  thinking: 'yellow',
  tool: 'cyan',
  blocked: 'red',
  error: 'red',
  offline: 'gray',
};

export interface SidebarProps {
  handle: string;
  view: View;
  peers: Agent[];
  memberRooms: Room[];
  discoverRooms: Room[];
  dmUnreadByPeer: Map<string, number>;
  roomUnreadByName: Map<string, number>;
}

/** Prefix shown before the first 9 sidebar entries — matches the 1-9
 *  jump-key ordering (peers → member rooms → discover rooms). Items past
 *  the 9th get a 3-space pad so vertical alignment stays intact. */
function jumpPrefix(nth: number): string {
  return nth < 9 ? `[${nth + 1}]` : '   ';
}

export function Sidebar({
  view,
  peers,
  memberRooms,
  discoverRooms,
  dmUnreadByPeer,
  roomUnreadByName,
}: SidebarProps): React.ReactElement {
  // Running index across all three sections so the [N] prefix matches
  // App.tsx's 1-9 jump ordering exactly.
  let jumpN = 0;
  return (
    <Box
      flexDirection="column"
      width={30}
      flexShrink={0}
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
          const prefix = jumpPrefix(jumpN++);
          return (
            <Box key={p.handle} flexDirection="column">
              <Text>
                {active ? <Text color="cyan">▸</Text> : <Text> </Text>}
                <Text dimColor>{prefix} </Text>
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
                <Text dimColor>       {p.focus}</Text>
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
      {memberRooms.length === 0 && discoverRooms.length === 0 ? (
        <Text dimColor>(none — /join #x)</Text>
      ) : (
        <>
          {memberRooms.map((r) => {
            const active = view.kind === 'room' && view.room === r.name;
            const unread = roomUnreadByName.get(r.name) ?? 0;
            const prefix = jumpPrefix(jumpN++);
            return (
              <Text key={r.name}>
                {active ? <Text color="cyan">▸</Text> : <Text> </Text>}
                <Text dimColor>{prefix} </Text>
                <Text color="cyan" bold={active}>{r.name}</Text>
                {unread > 0 && <Text color="yellow"> ({unread})</Text>}
              </Text>
            );
          })}
          {discoverRooms.length > 0 && (
            <Text dimColor>     ── join ──</Text>
          )}
          {discoverRooms.map((r) => {
            const prefix = jumpPrefix(jumpN++);
            return (
              <Text key={r.name}>
                {' '}
                <Text dimColor>{prefix} </Text>
                <Text color="gray">＋ </Text>
                <Text dimColor>{r.name}</Text>
              </Text>
            );
          })}
        </>
      )}
    </Box>
  );
}
