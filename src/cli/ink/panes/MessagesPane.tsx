import React from 'react';
import { Box, Text } from 'ink';
import type { Message, MessageKind } from '../../../storage/dao.js';
import type { View } from '../views.js';
import { HomeEmptyState, DmEmptyState, RoomEmptyState } from './EmptyState.js';
import { ScrollableMessageList } from './ScrollableMessageList.js';
import { Markdown } from '../util/markdown.js';
import { useMessageViewport, useTerminalColumns } from '../util/viewport.js';
import { stampOf as timeOf } from '../../../util/time.js';
import { wrapBody, wrappedRowCount } from '../../../util/wrap.js';

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

/** Factory: yields a renderRow closure that pre-wraps message bodies to
 *  fit the current content width. We own the wrap instead of relying on
 *  Ink's Text-wrap-inside-a-Box chain — that chain wraps correctly in
 *  headless renders but has failed to constrain long lines in some live
 *  terminals, causing text to bleed past the pane border. Hard-breaks
 *  tokens longer than the column budget so nothing overflows. */
function makeRenderRow(bodyWidth: number): (m: Message, meHandle: string) => React.ReactElement {
  // paddingLeft=2 eats 2 cols on the left; leave one for safety on the right.
  const wrapCols = Math.max(10, bodyWidth - 3);
  return function renderRow(m, meHandle) {
    const wrapped = wrapBody(m.body, wrapCols);
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
          <Markdown body={wrapped} baseColor={KIND_COLOR[m.kind]} />
        </Box>
      </Box>
    );
  };
}

interface MessagesPaneProps {
  view: View;
  messages: Message[];
  meHandle: string;
  focused?: boolean;
}

export function MessagesPane({ view, messages, meHandle, focused = true }: MessagesPaneProps): React.ReactElement {
  const viewportRows = useMessageViewport();
  const contentColumns = Math.max(20, useTerminalColumns() - HORIZONTAL_CHROME);
  const renderRow = React.useMemo(() => makeRenderRow(contentColumns), [contentColumns]);
  // Row estimator uses the SAME wrap width as the renderer (contentColumns - 3)
  // so the visible-slice budget matches actual rendered rows. Char-count
  // estimators under-count by 15-25% because wrapBody breaks at whitespace.
  const wrapCols = Math.max(10, contentColumns - 3);
  const rowsForMessage = React.useCallback(
    (m: Message) => 1 /* header */ + wrappedRowCount(m.body, wrapCols),
    [wrapCols],
  );
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
            focused={focused}
            rowsForMessage={rowsForMessage}
            renderRow={renderRow}
          />
        )}
      </Box>
    </>
  );
}
