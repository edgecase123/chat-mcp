---
name: observability-scanner
description: Finds the places in foreUP `fu` code (CodeIgniter `application/`, Symfony `api_rest/`) where a log line, log context, or correlation id would make production behaviour diagnosable in Grafana/Loki — swallowed exceptions and silent failure paths, log calls missing the ids needed to join them (course, sale, charge, processor, request uid), dead `log_message()` calls, unsearchable messages — and returns a ranked report with paste-ready `Log::` snippets plus the LogQL query and alert idea for each. Use whenever someone asks where to add logging, how to make a feature/branch/class more observable or debuggable in prod, why something can't be found in Loki, what to log for a new flow, or wants an observability review of a diff or file before a PR — even if they just say "add some logging" or "we couldn't trace this in Grafana". Read-only; proposes, never edits.
---

# Observability Scanner — foreUP `fu`

**Harness-neutral.** Needs only file reading and read-only shell (`git`). Works in Claude Code, Cursor, Codex, or any agent that loads `SKILL.md`. Run in a subagent/background task if your harness has one; otherwise inline. Do not edit files: the output is a proposal the developer applies after review.

## Why this exists

When something breaks in production here, the investigation happens in Grafana against Loki. A failure is only diagnosable if three things were true when the code ran:

1. **Something was logged at the point of failure** — not swallowed by a `catch`, a `return false`, or a dead logger.
2. **The line carries the ids that let you find it and join it** — which course, which sale/charge/transfer, which processor object, which request.
3. **Someone can actually query it** — a stable message string and context fields that LogQL can filter on.

Your job is to find where one of those three is missing, rank by how much a gap would hurt during an incident, and hand back the exact fix. Favour a few high-value findings over a long list — every proposed line costs log volume, and noise makes incidents harder, not easier.

## How logging works in this repo (verified facts — rely on these)

**The facade.** Both trees use `foreup\Common\Logging\Log` (package `foreup/common`, present in both `application/vendor` and `api_rest/vendor`):

```php
use foreup\Common\Logging\Log;
Log::error('Hydra ~ Odin capture failed', [
    'module' => 'hydra',
    'course_id' => $courseId,
    'charge_id' => $charge->getId(),
    'exception' => $e,
]);
```

Levels: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`. Signature `($message, array $context = null)`.

**Output format.** The stdout driver writes logfmt-style lines that Loki-APP ingests:
`lvl=ERROR chan=stdout msg="Hydra ~ Odin capture failed" module=hydra course_id=123 … _env=prod _app=symfony _uid=614c99e`
- Each context key becomes a field you can filter after `| logfmt`.
- Passing a `Throwable` under the `exception` key serialises it as JSON with `class`, `message`, `code`, `file`, `trace` — prefer this over concatenating `$e->getMessage()` into `msg` (the message loses the class and stack).
- `_uid` is a per-request id added automatically.

**Context helpers.** `Log::withContext([...])` attaches context to subsequent lines in the request; `Log::shareContext([...])` / `Log::addSharedContext([...])` set context shared across channels. Use these at a flow's entry point (controller action, message handler) so every downstream line carries `course_id` etc. without repeating it.

**Request correlation across tiers.** The CI app forwards its uid when it calls the Symfony API through the SDK: `$sdk->propagateRequestUid(Log::getUid())` (see `application/controllers/booking.php`, `application/controllers/api/food_and_beverage.php`). Symfony adopts it in `App\EventSubscriber\RequestUidPropagationSubscriber` (header `ApiElement::REQUEST_UID_HEADER`, then `Log::applyPropagatedUid()`). Uids must be alphanumeric, ≤ 32 chars.

**`log_message()` is dead in CodeIgniter.** `$config['log_threshold'] = 0` in `application/config/config.php` and in the `development/` and `testing/` overrides; `production/` has no `config.php`, so it inherits 0. CI 2's `CI_Log::write_log()` returns before writing at threshold 0. Any `log_message()` call — new or existing — produces nothing anywhere. Replace with `Log::`.

**Where logs land in Grafana.** Datasource Loki-APP. `job` label separates tiers: `fu-prod` (web/API), `fu-worker-prod` (SQS/Messenger workers), `fu-dev` / `fu-worker-dev`, team envs (`fu-walrus`, `fu-gulls`, …). Other labels include `lvl` and `module`. Labels are cheap to filter on; logfmt fields need `| logfmt` first.

**Existing timing instrumentation** (`PaymentPerformanceLog`) is out of scope for this skill — don't propose timing/latency changes.

## Inputs

- **Diff mode (default):** `origin/dev...HEAD` (PRs target `dev`; `origin/main...HEAD` for a hotfix), or a range the user gives. Get files with `git diff --name-only <range>`, read changed hunks with `git diff -U0 <range>`, then open each file for surrounding context. Judge the *flows the diff touches*, including unchanged lines in those methods — a new call path through an old silent `catch` is a finding.
- **File/class mode:** one or more paths or a class name. Read the whole class; map its public entry points and every exit path.

Skip `**/tests/**`, `vendor/`, `system/`, `node_modules/`, `dist/`, and frontend code (browser logs don't reach Loki).

## What to look for

Work through each touched method and ask: *if this went wrong in prod at 2am, what would the on-call person search for, and would they find it?*

### 1. Errors and silent failures (rank highest)

These are the gaps that turn an incident into guesswork.

- **Swallowed exceptions** — `catch` blocks that are empty, only `return false/null/[]`, `continue`, or set a flag, with no `Log::`. Especially around processor/HTTP calls (Guzzle `ClientException`/`RequestException`, Odin/Finix/Stripe services), DB writes, SQS/Messenger handling, and file/IO.
- **Failure returns with no trace** — methods in money, booking, or sync paths that `return false` / an error array on a branch the caller can't explain (validation that rejects silently, "not found" in a reconciliation loop).
- **Exception logged without the object** — `Log::error('Failed: '.$e->getMessage())` → move to `'exception' => $e`.
- **Wrong level** — `info`/`debug` for real failures (invisible to `lvl=ERROR` alerts); `error` for expected business outcomes (declined card, user typo) which floods alerts — use `warning` or `notice`.
- **Double logging** — the same exception logged at every layer while rethrowing. Log once where it's handled (or at the boundary that converts it to a response), not at each rethrow.
- **Dead or hidden logging** — `log_message()` in CI (always a no-op, see above); `@`-suppressed calls hiding errors; `error_log()`/`echo`/`var_dump` debugging that bypasses the facade.
- **Loops that fail per item** — a batch/sync loop that skips failing items without logging which item and why; and conversely, no summary line (counts processed / skipped / failed) after a batch, which is the cheapest high-value line in any job.

### 2. Context and correlation

A log line you can't attribute is nearly as bad as no line.

- **Missing join keys.** Include the ids an investigator would filter by: `course_id`; the domain object ids (`sale_id`, `invoice_id`, `teetime_id`, `charge_id`, `transfer_id`, `authorization_id`); processor object ids (Odin payment intent, Finix transfer/merchant ids); `employee_id`/`person_id` as ids; message/job id in workers. Ids only — never names, emails, phone numbers, card data, or credentials.
- **Variables interpolated into the message.** `Log::info("Charge $id failed for course $courseId")` makes every line unique, so it can't be grouped, counted, or alerted on. Keep `msg` a constant phrase; move variables into context.
- **No `module` key** on a feature's lines → harder to scope a query. Match the module naming already used nearby (e.g. `OdinDriver::MODULE`).
- **Repeated context** on every call in a flow → suggest one `Log::withContext([...])` at the entry point instead.
- **Broken uid chain.** A CI → Symfony SDK call in the touched code without `propagateRequestUid(Log::getUid())`; work dispatched to SQS/Messenger without carrying the originating uid (or at least `course_id` + object id) in the message, so the worker's lines can't be tied back to the request that queued them.

### 3. Loki queries and alerts

For every line you propose or change, give the query that finds it, so the line is proven useful before it ships:

```logql
{job="fu-prod", lvl="ERROR"} |= "Hydra ~ Odin capture failed" | logfmt | course_id="6270"
```

- Pick `job` by where the code runs: controllers/web → `fu-prod`; `SQSListeners/`, `MessageHandler/`, CLI/cron → `fu-worker-prod`.
- Use `|=` on the constant message first (fast line filter), then `| logfmt` and field filters.
- Where the line represents a failure someone should hear about, suggest an alert expression, e.g. `sum(count_over_time({job="fu-prod"} |= "Hydra ~ Odin capture failed" [5m])) > 5`, and say what threshold reasoning you used. Don't create alerts — propose them.

## Guardrails

- **No sensitive data in context.** Credentials (processor API users/passwords, tokens), card numbers/CVV/track data, and personal data (names, emails, phones, addresses) never go into a log line. If the natural thing to log is an object or request body, log its id and the specific non-sensitive fields instead. If you spot existing lines that already leak, note them in one line and point to the `security-scanner` skill if available — don't expand on the values.
- **Volume.** Don't propose `info` lines inside tight loops or per-row hot paths; use a summary line after the loop, or `debug`. Prefer one well-contexted line at a decision point over several breadcrumbs.
- **Fit the tree.** PHP 7.4 in both trees. In `application/`, add `use foreup\Common\Logging\Log;` at the top of the file if it's not there (many CI files already do). In `api_rest/`, match nearby convention (some services inject a PSR logger; most use the static facade).
- **No code edits.** Present snippets; the developer applies them.

## Report format

Use this shape so findings are easy to triage. Keep it under ~80 lines; if one pattern repeats in many places, show the top 3 and say "same pattern in N more places".

```
## Scope
<mode · range or paths · N files / M methods reviewed · job(s) these run under>

## Findings (ranked)

### 1. 🔴 <short title> — <file>:<line> `<Class::method>`
Gap: <what's missing and what an investigator couldn't answer today>
Add:
    <paste-ready PHP snippet>
Find it:
    <LogQL query>
Alert (optional): <expression + one-line rationale>

### 2. 🟡 …

## Already good
<1–3 bullets on existing logging in scope that's done right, so it isn't "fixed">

## Not proposed
<things you considered and rejected, e.g. "per-row info log in loop — volume">
```

Severity:
- 🔴 a failure in this code would be invisible or unattributable in Loki today (swallowed exception, dead `log_message()` on an error path, money/booking failure with no line).
- 🟡 it would be findable but slow to diagnose (missing join ids, interpolated message, wrong level, broken uid chain).
- 🟢 polish (module key, summary counts on a healthy batch, context consolidation).

If the scope is already well instrumented, say so plainly and list what's good — an empty findings list is a valid result.
