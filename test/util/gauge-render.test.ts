import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGauge } from '../../src/cli/ink/util/gauge-render.js';

test('renderGauge — null total → unreported "—"', () => {
  const g = renderGauge({ context_used: 100, context_total: null });
  assert.equal(g.reported, false);
  assert.equal(g.label, '—');
  assert.equal(g.dim, true);
});

test('renderGauge — null used → unreported "—"', () => {
  const g = renderGauge({ context_used: null, context_total: 1000 });
  assert.equal(g.reported, false);
});

test('renderGauge — zero total → unreported "—" (div by zero guard)', () => {
  const g = renderGauge({ context_used: 10, context_total: 0 });
  assert.equal(g.reported, false);
});

test('renderGauge — 12% is green, dim, not bold', () => {
  const g = renderGauge({ context_used: 12, context_total: 100 });
  assert.equal(g.label, '12%');
  assert.equal(g.color, 'green');
  assert.equal(g.dim, true);
  assert.equal(g.bold, false);
});

test('renderGauge — 70% enters soft band (yellow, not bold)', () => {
  const g = renderGauge({ context_used: 70, context_total: 100 });
  assert.equal(g.label, '70%');
  assert.equal(g.color, 'yellow');
  assert.equal(g.bold, false);
});

test('renderGauge — 84% still soft', () => {
  const g = renderGauge({ context_used: 84, context_total: 100 });
  assert.equal(g.color, 'yellow');
  assert.equal(g.bold, false);
});

test('renderGauge — 85% enters warn band (yellow + bold)', () => {
  const g = renderGauge({ context_used: 85, context_total: 100 });
  assert.equal(g.color, 'yellow');
  assert.equal(g.bold, true);
});

test('renderGauge — 95% enters critical band (red + bold)', () => {
  const g = renderGauge({ context_used: 95, context_total: 100 });
  assert.equal(g.color, 'red');
  assert.equal(g.bold, true);
});

test('renderGauge — rounds toward nearest integer', () => {
  // 725/1000 = 72.5% → rounds to 73
  const g = renderGauge({ context_used: 725, context_total: 1000 });
  assert.equal(g.label, '73%');
});
