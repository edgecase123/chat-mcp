import React from 'react';
import { Box, Text } from 'ink';
import type { Agent, AgentStatus } from '../../../storage/dao.js';
import { stampOf as timeOf } from '../../../util/time.js';

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'green',
  thinking: 'yellow',
  tool: 'cyan',
  blocked: 'red',
  error: 'red',
  offline: 'gray',
};

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

interface WhoPaneProps {
  peers: Agent[];
  meHandle: string;
}

export function WhoPane({ peers, meHandle }: WhoPaneProps): React.ReactElement {
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
