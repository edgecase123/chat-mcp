import React from 'react';
import { Box, Text } from 'ink';
import type { Message, MessageKind } from '../../../storage/dao.js';
import type { View } from '../views.js';
import { HomeEmptyState, DmEmptyState, RoomEmptyState } from './EmptyState.js';
import { ScrollableMessageList } from './ScrollableMessageList.js';
import { Markdown } from '../util/markdown.js';
import { useMessageViewport } from '../util/viewport.js';

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

function timeOf(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

function renderRow(m: Message, meHandle: string): React.ReactElement {
  return (
    <Box key={m.id} flexDirection="column">
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
      <Box paddingLeft={2}>
        <Markdown body={m.body} baseColor={KIND_COLOR[m.kind]} />
      </Box>
    </Box>
  );
}

interface MessagesPaneProps {
  view: View;
  messages: Message[];
  meHandle: string;
}

export function MessagesPane({ view, messages, meHandle }: MessagesPaneProps): React.ReactElement {
  const viewportRows = useMessageViewport();
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
          view.kind === 'home' ? <HomeEmptyState /> :
          view.kind === 'dm' ? <DmEmptyState peer={view.peer} /> :
          view.kind === 'room' ? <RoomEmptyState room={view.room} /> :
          null
        ) : (
          <ScrollableMessageList
            messages={messages}
            meHandle={meHandle}
            viewportRows={viewportRows}
            focused={true}
            renderRow={renderRow}
          />
        )}
      </Box>
    </>
  );
}
