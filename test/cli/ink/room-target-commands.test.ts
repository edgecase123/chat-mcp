import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getCompletions } from "../../../src/cli/ink/input/completions.js";
import { COMMANDS } from "../../../src/cli/ink/commands.js";
import { roomTargetRefusal } from "../../../src/util/naming.js";

/**
 * `/dm` and `/dispatch` answered `unknown peer: #mcp` for a room, though each
 * has a room form — `/join` and `/broadcast` — and neither refusal named it.
 * They now accept a `#` target the way `/alert` already did. #277.
 */

const ctx = {
  me: "claude2",
  peers: ["claude1", "pclaude", "lee"],
  memberRooms: ["#leagues", "#gate"],
  discoverRooms: ["#planning", "#deploy"],
};

const suggest = (line: string) =>
  getCompletions(line, line.length, ctx).map((c) => c.value);

test("/dm offers the rooms the caller is in once the token starts with #", () => {
  assert.deepEqual(suggest("/dm #"), ["#leagues", "#gate"]);
  assert.deepEqual(suggest("/dm #ga"), ["#gate"]);
});

test("/dispatch offers the rooms the caller is in once the token starts with #", () => {
  assert.deepEqual(suggest("/dispatch #"), ["#leagues", "#gate"]);
  assert.deepEqual(suggest("/dispatch #ga"), ["#gate"]);
});

/**
 * CONTROL. Without it a change that offered rooms for EVERY first argument
 * would satisfy both tests above.
 */
test("a target without a # still offers peers and never a room", () => {
  assert.deepEqual(suggest("/dm cla"), ["claude1"]);
  assert.deepEqual(suggest("/dispatch "), ["claude1", "pclaude", "lee"]);
});

/**
 * CONTROL. `/kick` deliberately did NOT gain a room form — lee ruled it a text
 * change only — so its completions must still be peer-only.
 */
test("/kick gained no room form, so it offers no rooms", () => {
  assert.deepEqual(suggest("/kick #"), []);
  assert.deepEqual(suggest("/kick cla"), ["claude1"]);
});

test("/kick's refusal names /rooms and does not call itself a send", () => {
  const text = roomTargetRefusal("#mcp", "Room operations are /rooms.", "kick");

  assert.match(text, /#mcp is a room, and kick is peer-only\./);
  assert.match(text, /\/rooms/);
  assert.doesNotMatch(
    text,
    /send is peer-only/,
    "the shared clause still claims this is a send",
  );
});

/**
 * CONTROL. The `operation` argument is defaulted so the two send surfaces keep
 * the one sentence `test/messaging/room-target-refusal.test.ts` pins.
 */
test("the default operation is still send", () => {
  assert.match(
    roomTargetRefusal("#mcp", "Use room_send."),
    /#mcp is a room, and send is peer-only\./,
  );
});

/**
 * Commands whose `#` branch REFUSES rather than accepts, so autocomplete must
 * keep offering peers only.
 *
 * ⚠️ Each line is a claim about what that branch DOES. A command that starts
 * accepting a room belongs in `kind: "target"`, not here — so deleting its
 * entry is the change, never widening the list.
 */
const REFUSES_A_HASH: Record<string, string> = {
  kick: "lee ruled #277 a text change only; it names /rooms and stops",
};

/**
 * 🛑 THE DRIFT THIS GUARDS IS THE ONE THIS FIX NEARLY SHIPPED WITH. Teaching a
 * handler to branch on `#` while leaving its `commands.ts` arg as
 * `kind: "peer"` leaves autocomplete offering peers only — so the new
 * behaviour is unreachable to anyone who completes rather than types it.
 *
 * It is asserted BOTH WAYS on purpose. One direction alone would let the next
 * command drift in whichever direction is unchecked.
 */
test("a handler that ACCEPTS a # declares kind: target, and the reverse", () => {
  const src = readFileSync(
    new URL("../../../src/cli/ink/App.tsx", import.meta.url).pathname,
    "utf8",
  );

  // Slice the `doCommand` switch into one body per `case "name":`, so a branch
  // is attributed to the command that owns it rather than to the file.
  const bodies = new Map<string, string>();
  const parts = src.split(/\n\s*case "([a-z-]+)": \{\n/);
  for (let i = 1; i < parts.length; i += 2) {
    bodies.set(parts[i]!, parts[i + 1]!.split(/\n\s*case "/)[0]!);
  }

  // NON-VACUITY. The splitter has to have found the commands under test, or
  // every assertion below passes over an empty map.
  for (const name of ["dm", "dispatch", "alert", "kick"]) {
    assert.ok(bodies.has(name), `the splitter did not find case "${name}"`);
  }

  const declaresTarget = [
    ...new Set(
      COMMANDS.filter((c) => c.args.some((a) => a.kind === "target")).map((c) =>
        c.name.slice(1),
      ),
    ),
  ].sort();
  const acceptsAHash = [...bodies]
    .filter(([n, b]) => b.includes('startsWith("#")') && !REFUSES_A_HASH[n])
    .map(([n]) => n)
    .sort();

  assert.ok(declaresTarget.length > 0, "no command declares kind: target");
  assert.deepEqual(
    declaresTarget,
    acceptsAHash,
    `declares kind:"target" = ${declaresTarget.join(",")}; ` +
      `accepts a # = ${acceptsAHash.join(",")}; ` +
      `exempt = ${Object.keys(REFUSES_A_HASH).join(",")}`,
  );

  // The exemption has to still be reachable, or it is a stale name silently
  // excusing nothing.
  for (const [name, why] of Object.entries(REFUSES_A_HASH)) {
    assert.ok(
      bodies.get(name)?.includes('startsWith("#")'),
      `${name} is exempt for "${why}" but no longer branches on #`,
    );
  }
});
