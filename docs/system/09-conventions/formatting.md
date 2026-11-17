---
title: Code formatting
updated: 2026-11-17
covers:
  - package.json
  - .prettierignore
  - .git-blame-ignore-revs
  - .github/workflows/ci.yml
---

# Code formatting

Prettier formats this repo, and the rule is Prettier's own default. There is no
`.prettierrc`, and that absence is the decision rather than an omission.

---

## The two commands

| Command                | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `npm run format`       | Rewrites every file Prettier owns                     |
| `npm run format:check` | Lists the files that differ, exits non-zero if any do |

CI runs `format:check` after `tsc --noEmit` and before `npm test`, so a
formatting failure reads as formatting rather than as a broken test.

## Why there is no config file

A config is a local dialect. Every rule in it is a rule a contributor has to
learn, and a rule that has to be argued about once per pull request. Prettier's
defaults are the published standard, so adopting them whole means the formatting
question is settled rather than owned.

The visible consequences of the defaults, both of which this repo did **not**
follow before:

- **Double quotes**, not single.
- **80 columns**, which wraps long import lists onto one name per line.

## What Prettier does not touch

`.prettierignore` holds four entries. Three are uncontroversial — `dist/`,
`node_modules/` and `package-lock.json` are generated.

The fourth is `docs/superpowers/`. `docs/system/README.md` states that a spec
or a plan under that tree is frozen at the date in its filename, so running a
formatter across one edits a historical record instead of the codebase.

## Common pitfalls

- **A `file.ts:NNN` reference in prose goes stale when that file reflows.** The
  one-time reformat moved line numbers in most `.ts` files. A reference written
  before it points at the wrong line, not at nothing, so it fails silently.
- **`git blame` on a reformatted line shows the reformat, not the author.**
  `.git-blame-ignore-revs` fixes that, but only after you opt in — see below.

---

## Making `git blame` skip the reformat

**Run this once per clone:**

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

🛑 **The file alone does nothing.** `blame.ignoreRevsFile` is clone-local
config, and git has no way to set it from inside the repo. Without the command
above, `.git-blame-ignore-revs` sits there and blame still names the reformat.

### What it costs

The reformat reached `main` as a **squash**, so the only sha blame can ever name
is `491c632` — and that commit is not formatting-only. It bundles the Prettier
adoption with real work.

|                                | lines  | files |
| ------------------------------ | ------ | ----- |
| reformat, correctly skipped    | 37,669 | 320   |
| real change, now misattributed | ~240   | 16    |

So blame on a genuinely new line in one of those 16 files points one commit too
early. The pure reformat commit (`fb15837`) was squashed away and is
unreachable, so there is no formatting-only sha to name instead.

### Adding another entry

🛑 **A sha that does not resolve is skipped silently — no warning, exit 0.** A
typo reads exactly like a working entry. `test/blame-ignore-revs.test.ts` is
what catches that, and it also refuses a sha whose diff is too small to be a
repo-wide reformat.

---

## Source files

| File                       | Role                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| `package.json`             | The `format` and `format:check` scripts, and the `prettier` devDependency |
| `.prettierignore`          | The four paths Prettier skips                                             |
| `.git-blame-ignore-revs`   | The reformat sha `git blame` skips, once the clone opts in                |
| `.github/workflows/ci.yml` | Runs `format:check` on every push and pull request                        |

## Related docs

- [settings.md](../03-infrastructure/settings.md) — every env var, flag and tunable
