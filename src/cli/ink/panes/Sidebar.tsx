import React from 'react';
import { Box, Text } from 'ink';
import type { Agent, AgentStatus } from '../../../storage/dao.js';
import type * as dao from '../../../storage/dao.js';
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
  rooms: ReturnType<typeof dao.myRooms>;
  dmUnreadByPeer: Map<string, number>;
  roomUnreadByName: Map<string, number>;
}

export function Sidebar({
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
