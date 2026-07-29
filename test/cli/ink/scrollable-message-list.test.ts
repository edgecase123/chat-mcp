import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { ScrollableMessageList } from '../../../src/cli/ink/panes/ScrollableMessageList.js';
import { wrapBody, wrappedRowCount } from '../../../src/util/wrap.js';
import type { Message } from '../../../src/storage/dao.js';

function makeMessage(id: number, body: string): Message {
  return {
    id,
    from_handle: 'alice',
    to_handle: 'bob',
    to_room: null,
    kind: 'chat',
    body,
    sent_at: 1_700_000_000 + id,
    read_at: null,
  } as Message;
}

/** Renders the message body as MessagesPane does — pre-wrapped, indented by 2 —
 *  so the smoke test measures the same visual shape a live user would see. */
function renderRow(bodyWidth: number) {
  const wrapCols = Math.max(10, bodyWidth - 3);
  return function row(m: Message): React.ReactElement {
    const wrapped = wrapBody(m.body, wrapCols);
    return React.createElement(Box, { key: m.id, flexDirection: 'column' },
      React.createElement(Text, null, `${m.from_handle} ${m.id}`),
      React.createElement(Box, { paddingLeft: 2 },
        React.createElement(Text, null, wrapped),
      ),
    );
  };
}

test('no rendered line exceeds the pane content width', () => {
  const contentColumns = 60;
  const messages: Message[] = [
    makeMessage(1, 'short one'),
    makeMessage(2, 'a '.repeat(200).trim()),
    makeMessage(3, 'longtokenthatwilloverflowtheline'.repeat(4)),
    makeMessage(4, 'mixed content ' + 'x'.repeat(120) + ' end'),
    makeMessage(5, 'line one\nline two ' + 'y'.repeat(90)),
  ];
  const { lastFrame } = render(
    React.createElement(Box, { width: contentColumns, flexDirection: 'column' },
      React.createElement(ScrollableMessageList, {
        messages,
        meHandle: 'bob',
        viewportRows: 40,
        contentColumns,
        focused: false,
        renderRow: renderRow(contentColumns),
      }),
    ),
  );
  const frame = lastFrame() ?? '';
  const overflowing = frame.split('\n').filter((l) => l.length > contentColumns);
  assert.equal(
    overflowing.length,
    0,
    `expected no overflow; got:\n${overflowing.map((l) => `  [${l.length}] ${l}`).join('\n')}`,
  );
});

test('wrappedRowCount matches the actual rendered row count', () => {
  // Ground-truth check: the estimator must never under-count, or the
  // pane's row budget will overspend and push chrome off-screen.
  const cols = 40;
  const cases = [
    'short',
    'the quick brown fox jumps over the lazy dog '.repeat(3).trim(),
    'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(4).trim(),
    'line one\nline two is definitely long enough to wrap over multiple lines when the terminal is narrow',
    'longtokenthatwontsplitcleanly' + 'x'.repeat(80),
    '',
  ];
  for (const body of cases) {
    const estimated = wrappedRowCount(body, cols);
    const actual = wrapBody(body, cols).split('\n').length;
    assert.equal(estimated, actual, `for body of length ${body.length}: estimated ${estimated}, actual ${actual}`);
  }
});

test('char-count estimator (old behavior) DOES undercount vs wrappedRowCount', () => {
  // Documents WHY the new estimator exists: for prose whose word lengths
  // don't tile cleanly into `cols`, whitespace-aware wrap produces more
  // lines than ceil(len / cols) predicts. That gap is what pushed the
  // input bar off-screen in live use.
  const cols = 10;
  // 5 seven-char words + spaces = 39 chars. ceil(39/10) = 4 rows. Real
  // wrap: each word + trailing space is 8 chars; adding the next would
  // hit 15, so wrap breaks after each word — 5 rows.
  const body = 'abcdefg '.repeat(5).trim();
  const oldEstimate = Math.max(1, Math.ceil(body.length / cols));
  const accurate = wrappedRowCount(body, cols);
  assert.ok(
    accurate > oldEstimate,
    `expected accurate estimate (${accurate}) > old ceil-based estimate (${oldEstimate})`,
  );
});

test('row-budget slice actually fits within viewportRows', () => {
  const contentColumns = 80;
  const viewportRows = 20;
  // A pile of long messages that all wrap. Estimator MUST count the real
  // rendered rows or the visible slice will overflow the viewport and the
  // input bar / status line will get pushed off-screen in live use.
  const messages: Message[] = Array.from({ length: 30 }, (_, i) =>
    makeMessage(
      i + 1,
      `msg ${i + 1}: ` +
        // Length just over N * (contentColumns - 3) so real wrap uses N+1 rows
        // but the character-count estimator says N. Repeated for enough
        // messages that the cumulative undercount blows the budget.
        'the quick brown fox jumps over the lazy dog '.repeat(4).trim(),
    ),
  );
  const { lastFrame } = render(
    React.createElement(Box, { width: contentColumns, flexDirection: 'column' },
      React.createElement(ScrollableMessageList, {
        messages,
        meHandle: 'bob',
        viewportRows,
        contentColumns,
        focused: false,
        renderRow: renderRow(contentColumns),
      }),
    ),
  );
  const frame = lastFrame() ?? '';
  const lineCount = frame.split('\n').length;
  // Allow a tiny margin (top/bottom indicators, one-off rounding), but the
  // rendered slice must not exceed the viewport row budget by more than a
  // couple of rows — otherwise the pane pushes chrome off-screen.
  assert.ok(
    lineCount <= viewportRows + 2,
    `rendered ${lineCount} rows, viewport was ${viewportRows} — overflow of ${lineCount - viewportRows}`,
  );
});
