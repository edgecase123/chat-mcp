import React from 'react';
import { Box, Text } from 'ink';
import { stampOf as timeOf } from '../../../util/time.js';

export interface Alert {
  id: number;
  from: string;
  to: string;
  body: string;
  ts: number;
}

export function AlertLane({ alerts }: { alerts: Alert[] }): React.ReactElement | null {
  if (alerts.length === 0) return null;
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column" flexShrink={0}>
      {alerts.map((a) => (
        <Text key={a.id}>
          <Text color="red" bold>🚨 ALERT</Text>{' '}
          <Text color="green" bold>{a.from}</Text>{' '}
          <Text dimColor>→ {a.to} · {timeOf(a.ts)}</Text>{' '}
          <Text>{a.body}</Text>
        </Text>
      ))}
      <Text dimColor>(/ack to dismiss)</Text>
    </Box>
  );
}
