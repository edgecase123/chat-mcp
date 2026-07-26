import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, CATEGORIES, findCommand } from '../../../src/cli/ink/commands.js';

test('every command has a category, description, and name', () => {
  for (const c of COMMANDS) {
    assert.match(c.name, /^\/[a-z-]+$/, `${c.name} shape`);
    assert.ok(c.description.length > 0, `${c.name} description`);
    assert.ok(CATEGORIES.includes(c.category), `${c.name} category valid`);
  }
});

test('command names are unique', () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test('findCommand resolves by exact name', () => {
  assert.equal(findCommand('/dm')?.name, '/dm');
  assert.equal(findCommand('/nope'), undefined);
});

test('every existing command from App.tsx doCommand is present', () => {
  const expected = [
    '/quit', '/exit', '/help', '/back', '/rooms', '/who', '/dm', '/join',
    '/leave', '/set-status', '/dispatch', '/broadcast', '/alert',
    '/watch', '/unwatch', '/ack',
  ];
  for (const name of expected) {
    assert.ok(findCommand(name), `missing ${name}`);
  }
});
