import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-bus-guard-"));

/* ==========================================================================
 * 🛑 WHY THIS FILE EXISTS. `host-bus-registers-at-bind.test.ts` asserts the
 * row and its offline reading on the HAPPY path. Neither of its tests reaches
 * either guard below, so both shipped in PR 464 with nothing holding them.
 *
 * guard A  `registerChildOffline`'s check that `clearAgentPid` matched a
 *           row, which THROWS when it did not
 * guard C  `openHostBus`'s hand-written `catch`, which closes the listener
 *           it bound one statement earlier before that throw propagates
 *
 * 🛑 ITS OWN FILE, NOT TWO MORE TESTS IN THE HAPPY-PATH ONE. `host-bus.js`
 * itself is never mocked — its DEPENDENCIES are, and it stays cached LINKED to
 * them after the mock reverts. So an unmocked assertion in the same file reads
 * the fakes too. Recorded precedent: the closing note in
 * `confirm-plan-floor-sourcing.test.ts`.
 *
 * 🛑 AND ONE TEST, NOT TWO, FOR THE SAME REASON ONE LEVEL DOWN. The mock
 * reverts with the TEST context while the importer stays cached, so a second
 * test here would meet an already-linked `host-bus.js` and measure whichever
 * `dao` the FIRST link captured. That is deterministic, not a race, which
 * makes it worse. Both guards fire on one `openHostBus` call, so one recording
 * answers both.
 *
 * ⚠️ WHAT GUARD C's ASSERTION DOES NOT COVER, because the next reader will
 * ask: with `mcp-listener.js` faked, this proves `host-bus` CALLS `close()`.
 * It does not prove a real loopback port was released. That is the right
 * subject — the leak PR 464 fixed was a missed call, not a broken socket.
 *
 * 🛑 GUARD B — the `await` on `ctx.notify.close()` in `registerChildOffline`
 * — IS DELIBERATELY NOT COVERED, and it is not a gap. `NotifyBus.close` has
 * zero `await` in its body, so dropping the keyword changes nothing
 * observable. A test for it would pin the keyword against a fake.
 * ======================================================================= */

test("🛑 a bus whose pid-null never lands refuses, and releases the listener it just bound", async (t: TestContext) => {
  const closed: string[] = [];
  const realDao = await import("../../src/storage/dao.js");

  /**
   * ⚠️ THE REAL MODULE IS SPREAD, NOT REPLACED. `shimContextFor` calls
   * `dao.upsertAgent` to write the row this guard then fails to amend, so a
   * bare one-export mock would remove the write and the guard would be
   * refusing a row that was never attempted.
   */
  t.mock.module("../../src/storage/dao.js", {
    namedExports: { ...realDao, clearAgentPid: () => false },
  });

  /**
   * ⚠️ A STATIC `bind` IS THE WHOLE SURFACE `host-bus` USES — it reads `.url`
   * and calls `.close()`. Recording the call makes the close the observable,
   * which is guard C's actual contract.
   */
  t.mock.module("../../src/supervise/mcp-listener.js", {
    namedExports: {
      McpHttpListener: {
        bind: async () => ({
          url: "http://127.0.0.1:1/mcp",
          close: async (): Promise<void> => {
            closed.push("listener");
          },
        }),
      },
    },
  });

  const { openHostBus } = await import("../../src/supervise/host-bus.js");

  await assert.rejects(
    () => openHostBus("guard-agent"),
    (err: Error) => {
      // 🛑 THE HANDLE AND THE WORD `ONLINE`, not merely "it threw". Discarding
      // the return value fails OPEN into exactly the phantom the message
      // names, so a bare `rejects` would pass for an unrelated throw.
      assert.match(err.message, /guard-agent/);
      assert.match(err.message, /ONLINE/);

      return true;
    },
    "a clearAgentPid that matched no row left the supervisor's pid on the handle",
  );

  // 🛑 THE CALL IS THE CLAIM, AND THE `await` IS NOT. `listener.close()` is
  // reachable only through the `HostBus` a throw never returns, so without the
  // hand-written catch this array is empty and the port is held for the life
  // of the process.
  //
  // ⚠️ DROPPING THAT `await` LEAVES THIS GREEN, MEASURED. The fake's `close`
  // has no `await` of its own, so the push lands at call time. A fake that
  // resolved late would pin microtask ordering instead, which is a flaky test
  // wearing a strict one's clothes.
  assert.deepEqual(
    closed,
    ["listener"],
    "the bound listener was never closed, so each startSupervisor retry leaks a loopback port",
  );
});
