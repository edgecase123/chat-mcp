import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_FILENAME,
  handoffPathFor,
  handoffPreamble,
} from "../../src/supervise/handoff.js";
import { CONTAINER_PROJECT_DIR } from "../../src/supervise/drivers/containerized.js";

/* ==========================================================================
 * 🛑 WHY THIS FILE EXISTS. lee ruled on 2026-11-26 that a handoff file lives
 * at `/work/HANDOFF.md` — the agent's own project directory as the CONTAINER
 * sees it, read and written by the agent itself.
 *
 * Two earlier designs for the same feature were WRONG and both are closed:
 *
 *   a mounted `local-context` directory   the file was unreachable from
 *                                         inside the container
 *   the container's own private /tmp      `docker run --rm` destroys it when
 *                                         the supervisor stops
 *
 * 🛑 `/work` IS NOT A LITERAL HERE AND MUST NOT BECOME ONE. It is the project
 * bind `dockerRunPlan` writes, so a second spelling of it would drift from the
 * mount silently — the agent would be told to read a path nothing is mounted
 * at, and the only symptom is a handoff that never appears.
 *
 * 🛑 THE HOST ARM IS NOT DECORATION. The same ruling has to mean something for
 * a host agent, which has no `/work`, and answering it with the container path
 * would send a host agent to a directory outside its own tree.
 * ========================================================================== */

test("🛑 a containerized agent is pointed at the project bind, not at a second spelling of it", () => {
  const path = handoffPathFor("docker", "/Users/someone/dev/whatever");

  assert.equal(path, `${CONTAINER_PROJECT_DIR}/${HANDOFF_FILENAME}`);

  // 🛑 THE CONTROL THAT MAKES THE LINE ABOVE WORTH ASSERTING. An
  // implementation that joined the HOST project dir would satisfy a check for
  // "ends with HANDOFF.md" and point the agent outside the container.
  assert.ok(
    !path.includes("/Users/someone"),
    "the container cannot see the host's project path",
  );
});

test("🛑 a host agent is pointed inside its OWN project directory", () => {
  const path = handoffPathFor("host", "/Users/someone/dev/whatever");

  assert.equal(path, `/Users/someone/dev/whatever/${HANDOFF_FILENAME}`);

  // The paired control: a host agent has no `/work`, so answering the host
  // arm with the container path is the failure this pins.
  assert.ok(
    !path.startsWith(CONTAINER_PROJECT_DIR),
    "a host agent has no container bind",
  );
});

test("🛑 the preamble names the resolved path and asks for BOTH halves", () => {
  const path = handoffPathFor("docker", "/ignored");
  const text = handoffPreamble(path);

  assert.ok(
    text.includes(path),
    "an agent cannot act on a path it is not given",
  );

  // 🛑 READ-IF-PRESENT AND WRITE-BEFORE-YOU-GO ARE ONE FEATURE. A preamble
  // that only asks for the read produces a file nobody ever writes, and the
  // whole mechanism is then silently inert. lee: *"it needs a place to both
  // read and write a hand off file"*.
  assert.match(text, /read/i);
  assert.match(text, /writ/i);

  // Every supervisor-authored prompt is marked, so a child can tell an
  // instruction from the bus apart from a peer's message.
  assert.ok(
    text.startsWith("[chat-mcp]"),
    "an unmarked prompt reads as a peer's",
  );
});

test("⚠️ the preamble does not claim the file exists", () => {
  const text = handoffPreamble(handoffPathFor("docker", "/ignored"));

  // 🛑 A FIRST START HAS NO HANDOFF, AND THAT IS THE COMMON CASE. Telling an
  // agent to read a file that is not there earns a tool error on turn one and
  // an agent that reports a fault instead of starting work.
  assert.match(text, /if it (is )?(there|present|exists)/i);
});

/**
 * 🔴 THE CLAIM THIS PREAMBLE SHIPPED ONCE AND THAT WAS FALSE. It ended
 * *"because nothing else can write it for you"*, argued from `docker cp`
 * having zero hits in this codebase.
 *
 * 🛑 THE PREMISE IS TRUE AND THE CONCLUSION DOES NOT FOLLOW. `/work` is a
 * READ-WRITE bind of the host project directory, so anything on the host
 * writing `<projectDir>/HANDOFF.md` reaches the container with no `docker cp`
 * involved. Raised by claude2 on PR 469 and verified in source.
 *
 * ⚠️ WHY IT MATTERS TO THE AGENT, WHICH IS WHO READS THIS STRING: told it is
 * the only writer, an agent has no reason to expect the file to have changed
 * under it — and operator seeding is what #463's own item 2 asked for.
 */
test("🔴 the preamble does not claim the agent is the EXCLUSIVE writer", () => {
  const text = handoffPreamble(handoffPathFor("docker", "/ignored"));

  assert.doesNotMatch(text, /nothing else can write/i);

  // The paired positive: the ask to write survives, because dropping the
  // false half must not drop the half the feature needs.
  assert.match(text, /write your own state back/i);
  assert.match(text, /can change between your turns/i);
});
