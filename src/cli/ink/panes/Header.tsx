import React from 'react';
import { Box, Text } from 'ink';
import type { AgentStatus } from '../../../storage/dao.js';
import { renderGauge } from '../util/gauge-render.js';

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'green',
  thinking: 'yellow',
  tool: 'cyan',
  blocked: 'red',
  error: 'red',
  offline: 'gray',
};

export interface HeaderProps {
  handle: string;
  version: string;
  status: AgentStatus | null;
  focus: string | null;
  contextUsed: number | null;
  contextTotal: number | null;
}

export function Header({
  handle,
  version,
  status,
  focus,
  contextUsed,
  contextTotal,
}: HeaderProps): React.ReactElement {
  const gauge = renderGauge({ context_used: contextUsed, context_total: contextTotal });
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexShrink={0}>
      <Text>
        <Text bold>chat-mcp</Text>{' '}
        <Text dimColor>v{version}-ink</Text> ·{' '}
        <Text color="cyan">{handle}</Text>
        {status && (
          <>
            {' '}· <Text color={STATUS_COLOR[status]}>●</Text> <Text>{status}</Text>
            {focus && (
              <>
                {' '}
                <Text dimColor>({focus})</Text>
              </>
            )}
          </>
        )}{gauge.reported && (
          <>
            {' '}· <Text dimColor>ctx</Text>{' '}
            <Text color={gauge.color} bold={gauge.bold} dimColor={gauge.dim}>
              {gauge.label}
            </Text>
          </>
        )}{' '}
        <Text dimColor>· /help · Ctrl-C</Text>
      </Text>
    </Box>
  );
}
