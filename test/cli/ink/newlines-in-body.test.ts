import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { MessagesPane } from '../../../src/cli/ink/panes/MessagesPane.js';
import type { Message } from '../../../src/storage/dao.js';

function make(body: string): Message {
  return {
    id: 1,
    from_handle: 'alice',
    to_handle: 'bob',
    to_room: null,
    kind: 'chat',
    body,
    sent_at: 1_700_000_000,
    read_at: null,
  } as Message;
}

function renderPane(body: string, cols = 60): string[] {
  const { lastFrame } = render(
    React.createElement(Box, { width: cols + 4, flexDirection: 'column' },
      React.createElement(MessagesPane, {
        view: { kind: 'dm', peer: 'alice' },
        messages: [make(body)],
        meHandle: 'bob',
        focused: true,
        contentColumns: cols,
      }),
    ),
  );
  return (lastFrame() ?? '').split('\n');
}

test('body newlines render as separate rows in the message pane', () => {
  const lines = renderPane('first line\nsecond line\nthird line');
  const trimmed = lines.map((l) => l.trim());
  assert.ok(trimmed.includes('first line'), `missing "first line" in ${JSON.stringify(trimmed)}`);
  assert.ok(trimmed.includes('second line'), `missing "second line" in ${JSON.stringify(trimmed)}`);
  assert.ok(trimmed.includes('third line'), `missing "third line" in ${JSON.stringify(trimmed)}`);
  // Order must be preserved.
  const idxFirst = trimmed.indexOf('first line');
  const idxSecond = trimmed.indexOf('second line');
  const idxThird = trimmed.indexOf('third line');
  assert.ok(idxFirst < idxSecond && idxSecond < idxThird, 'lines out of order');
});

test('consecutive newlines preserve blank lines between paragraphs', () => {
  const lines = renderPane('para one.\n\npara two.');
  const trimmed = lines.map((l) => l.trim());
  const idxOne = trimmed.indexOf('para one.');
  const idxTwo = trimmed.indexOf('para two.');
  assert.ok(idxOne >= 0 && idxTwo >= 0, 'both paragraphs must render');
  assert.ok(idxTwo - idxOne >= 2, `expected blank line between paragraphs (idx one=${idxOne}, two=${idxTwo})`);
});

test('newline before bold marker still renders on its own row', () => {
  const lines = renderPane('intro\n**bold second**');
  const trimmed = lines.map((l) => l.trim());
  assert.ok(trimmed.includes('intro'), 'intro row missing');
  assert.ok(trimmed.includes('bold second'), 'bold-second row missing');
});
