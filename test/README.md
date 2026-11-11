# Tests

`node:test` (built into Node ≥22.5) runs `test/**/*.test.ts` via `tsx`.

```bash
npm test                                # all
node --test --import tsx test/cli/ink/fuzzy.test.ts   # one file
```

Pure-logic modules only. UI components smoked via `npm run smoke` and manual `npm run dev -- cli --experimental --handle testuser`.

## 🛑 One test is skipped in CI, on purpose

`test/supervise/drivers/container-removal.test.ts` starts a real Docker
container. It is the only test in the suite that needs a live daemon.

**It runs locally and is skipped in CI, by lee's ruling of 2026-11-11.**
`docker run` pulls the image inside the test's own startup budget, so a runner
slow enough to miss that budget reds `main` with no defect behind it (#150).

```bash
npm run test:docker                     # the lane, on purpose
DOCKER_TESTS=1 npm test                 # the whole suite including the lane
```

The decision lives in `test/support/docker-lane.ts` and is unit-tested in
`test/support/docker-lane.test.ts`, including a control proving
`DOCKER_TESTS=0` does not force it on.

⚠️ **`npm test` reports `skipped 1` in CI and `skipped 0` locally.** A local
`skipped 1` means docker is not running, not that the lane was retired.

## 🛑 One test goes red with no code change, on purpose

`test/supervise/corpus-staleness.test.ts` fails when
`test/fixtures/captured-refusals.json` passes 30 days old.

That fixture is a replay of what real agent CLIs actually refused on a given
day (#42). It can become wrong without changing a byte, because the CLI it
describes changes underneath it. The age is the only signal that a recorded
refusal may no longer be what the CLI does.

```bash
CHAT_MCP_LIVE=1 node --import tsx scripts/capture-refusals.mjs   # spends money
node --import tsx scripts/rebuild-corpus.mjs
```

⚠️ **To unblock an unrelated fix for one run**, raise the ceiling:
`CHAT_MCP_CORPUS_MAX_AGE_DAYS=45 npm test`. That is an escape hatch, not a way
to retire the signal.
