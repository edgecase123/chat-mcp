import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Db } from '../../../storage/db.js';
import type { Room } from '../../../storage/dao.js';
import * as dao from '../../../storage/dao.js';

export interface RoomsBrowserProps {
  db: Db;
  handle: string;
  rooms: Room[];
  onOpen: (room: string) => void;
  onJoin: (room: string) => void;
}

function summariseMembers(db: Db, name: string, max = 3): string {
  const members = dao.roomMembers(db, name);
  const head = members.slice(0, max).join(', ');
  const extra = members.length > max ? ` +${members.length - max}` : '';
  return `${head}${extra}`;
}

export function RoomsBrowserPane({ db, handle, rooms, onOpen, onJoin }: RoomsBrowserProps): React.ReactElement {
  const [selected, setSelected] = useState(0);

  useInput((_raw, key) => {
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(rooms.length - 1, i + 1));
    if (key.return) {
      const r = rooms[selected];
      if (!r) return;
      if (dao.isRoomMember(db, r.name, handle)) onOpen(r.name);
      else onJoin(r.name);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Rooms · {rooms.length} active</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      {rooms.length === 0 ? (
        <Text dimColor>(no rooms yet — /join #x to create one)</Text>
      ) : (
        rooms.map((r, i) => {
          const active = i === selected;
          const joined = dao.isRoomMember(db, r.name, handle);
          const summary = summariseMembers(db, r.name);
          return (
            <Text key={r.name}>
              {active ? <Text color="cyan">▸</Text> : <Text> </Text>}
              {joined ? <Text color="cyan"> ✓ </Text> : <Text>   </Text>}
              <Text bold={active} color={active ? 'cyan' : joined ? 'cyan' : undefined}>{r.name.padEnd(14)}</Text>
              {'  '}
              <Text dimColor>{r.member_count} members · {summary}</Text>
            </Text>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · Enter open/join · /back close</Text>
      </Box>
    </Box>
  );
}
