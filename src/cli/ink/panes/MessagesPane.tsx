import React from 'react';
import { Box, Text } from 'ink';
import type { Message, MessageKind } from '../../../storage/dao.js';
import type { View } from '../views.js';
import { HomeEmptyState, DmEmptyState, RoomEmptyState } from './EmptyState.js';
import { ScrollableMessageList } from './ScrollableMessageList.js';
import { Markdown } from '../util/markdown.js';
import { useMessageViewport, useTerminalColumns } from '../util/viewport.js';
import { stampOf as timeOf } from '../../../util/time.js';

// Sidebar (30) + borders (~4) + main-pane paddingX (2) + safety (4) = ~40
// columns of chrome to the left of the message body. Subtract from total
// terminal width for wrap-row estimation in ScrollableMessageList.
const HORIZONTAL_CHROME = 40;

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

/** Factory: yields a renderRow closure that knows the body width to wrap
 *  at. Explicit width on the body Box forces Ink's Text wrap to respect
 *  the pane's boundary instead of letting long inline-styled runs
 *  (`<Text backgroundColor="gray">…</Text>` for inline code) overflow
 *  past the pane border. Ink can't hard-break unbreakable words like
 *  URLs; those may still visually spill, but well-spaced prose stops
 *  bleeding into the right border. */
function makeRenderRow(bodyWidth: number): (m: Message, meHandle: string) => React.ReactElement {
  return function renderRow(m, meHandle) {
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
        <Box paddingLeft={2} width={bodyWidth} overflowX="hidden">
          <Markdown body={m.body} baseColor={KIND_COLOR[m.kind]} />
        </Box>
      </Box>
    );
  };
}

interface MessagesPaneProps {
  view: View;
  messages: Message[];
  meHandle: string;
}

export function MessagesPane({ view, messages, meHandle }: MessagesPaneProps): React.ReactElement {
  const viewportRows = useMessageViewport();
  const contentColumns = Math.max(20, useTerminalColumns() - HORIZONTAL_CHROME);
  const renderRow = React.useMemo(() => makeRenderRow(contentColumns), [contentColumns]);
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
            key={view.kind === 'dm' ? `dm:${view.peer}` : view.kind === 'room' ? `room:${view.room}` : 'other'}
            messages={messages}
            meHandle={meHandle}
            viewportRows={viewportRows}
            contentColumns={contentColumns}
            focused={true}
            renderRow={renderRow}
          />
        )}
      </Box>
    </>
  );
}
