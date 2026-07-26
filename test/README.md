# Tests

`node:test` (built into Node ≥22.5) runs `test/**/*.test.ts` via `tsx`.

```bash
npm test                                # all
node --test --import tsx test/cli/ink/fuzzy.test.ts   # one file
```

Pure-logic modules only. UI components smoked via `npm run smoke` and manual `npm run dev -- cli --experimental --handle testuser`.
