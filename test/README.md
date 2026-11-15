# Tests

`node:test` (built into Node ≥22.5) runs `test/**/*.test.ts` via `tsx`.

```bash
npm test                                # all
node --test --import tsx test/cli/ink/fuzzy.test.ts   # one file
```

Pure-logic modules only. UI components smoked via `npm run smoke` and manual `npm run dev -- cli --experimental --handle testuser`.

## 🛑 The docker lane is skipped in CI, on purpose

Two files start a real Docker container, and they are the only tests in the
suite that need a live daemon.

| file                                                 | what it needs                                    |
| ---------------------------------------------------- | ------------------------------------------------ |
| `test/supervise/drivers/container-removal.test.ts`   | any image — it runs `alpine`                     |
| `test/supervise/drivers/container-toolchain.test.ts` | **`chat-mcp-agent:local` must already be BUILT** |

🛑 **`container-toolchain.test.ts` SKIPS WHEN THE AGENT IMAGE IS ABSENT, and
says so.** Building it is 1.18 GB and minutes, which is the same startup-budget
problem #150 ruled on — a test must not spend an image build inside its own
budget. Build it once with `./scripts/agent start <handle>`.

⚠️ **It runs the PRODUCTION install step in that image, on a throwaway named
volume it removes in a `finally`.** That is a cold `npm ci` of the whole
lockfile, so the file costs roughly 10s warm and longer on a cold npm cache. It
is also what found #242 — nothing else in the suite performs an in-container
install.

**It runs locally and is skipped in CI, by lee's ruling of 2026-11-11.**
`docker run` pulls the image inside the test's own startup budget, so a runner
slow enough to miss that budget reds `main` with no defect behind it (#150).

```bash
npm run test:docker                     # the whole suite, lane included
```

🛑 **That script runs the WHOLE suite with `DOCKER_TESTS=1`, and must keep
doing so.** Naming individual files there means a second test adopting
`dockerLaneSkip` runs NOWHERE — skipped by `npm test` in CI, unmatched by
`test:docker` — and both lanes still report green (claude1, PR #156 review).

The decision lives in `test/support/docker-lane.ts` and is unit-tested in
`test/support/docker-lane.test.ts`, including a control proving
`DOCKER_TESTS=0` does not force it on.

⚠️ **A local skip count above zero means the LANE did not run, not that it was
retired.** Docker not running skips all of them; a missing `chat-mcp-agent:local`
skips only `container-toolchain.test.ts`. Both reasons are printed with the skip,
so read it rather than counting.

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
