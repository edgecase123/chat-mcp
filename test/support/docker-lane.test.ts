import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerLaneSkip } from './docker-lane.js';

const present = () => true;
const absent = () => false;

test('🛑 CI never runs the docker lane — lee, 2026-11-11', () => {
  const reason = dockerLaneSkip({ CI: 'true' }, present);
  assert.equal(typeof reason, 'string');
  assert.match(reason as string, /local/i);
});

test('🛑 the CI check does NOT shell out to docker', () => {
  // A `docker version` probe on a runner costs time and can itself fail. The
  // lane decision is pure env, so the probe must never run.
  let probed = 0;
  dockerLaneSkip({ CI: 'true' }, () => {
    probed += 1;
    return true;
  });
  assert.equal(probed, 0);
});

test('a local run with docker present is NOT skipped', () => {
  assert.equal(dockerLaneSkip({}, present), false);
});

test('a local run without docker is skipped, and says so', () => {
  const reason = dockerLaneSkip({}, absent);
  assert.match(reason as string, /not available/i);
});

test('DOCKER_TESTS=1 forces the lane on in CI', () => {
  assert.equal(dockerLaneSkip({ CI: 'true', DOCKER_TESTS: '1' }, present), false);
});

test('⚠️ control — DOCKER_TESTS=0 does NOT force the lane on', () => {
  // An env var set to a falsy string is the classic way an escape hatch
  // becomes permanently open.
  assert.notEqual(dockerLaneSkip({ CI: 'true', DOCKER_TESTS: '0' }, present), false);
});

test('⚠️ control — DOCKER_TESTS cannot conjure a docker daemon', () => {
  // Forcing overrides the LANE, never the absence. Otherwise a forced run on
  // a machine with no docker fails with `container never started` instead of
  // saying docker is missing.
  const reason = dockerLaneSkip({ CI: 'true', DOCKER_TESTS: '1' }, absent);
  assert.match(reason as string, /not available/i);
});
