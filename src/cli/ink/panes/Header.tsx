import React from 'react';
import { Box, Text } from 'ink';
import type { AgentStatus } from '../../../storage/dao.js';

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
}

export function Header({ handle, version, status, focus }: HeaderProps): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
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
        )}{' '}
        <Text dimColor>· /help · Ctrl-C</Text>
      </Text>
    </Box>
  );
}
