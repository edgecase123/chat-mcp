import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-ctl-"));

const { WakeListener, requestSupervisorControl } =
  await import("../../src/supervise/socket.js");

/**
 * 🛑 THE THREE-WAY ACK BRANCH HAS ONE HOME NOW, AND THAT IS THE POINT.
 * `null` means nothing was listening, `{ ok: false }` means the supervisor
 * refused, and only the third case is a stop that will happen. Both the web
 * route and the `agents` CLI command used to derive this separately, so the
 * PR #158 fix for the truthy `{ ok: false }` existed twice.
 */

test("nothing listening is reported as a failure naming the handle", async () => {
  assert.deepEqual(
    await requestSupervisorControl("nobody", {
      kind: "stop",
      mode: "graceful",
    }),
    {
      handle: "nobody",
      ok: false,
      reason: "unreachable",
      error: "no supervisor is listening",
    },
  );
});

test("a refused control is a failure carrying the supervisor's reason", async () => {
  const l = await WakeListener.bind("refuser", () => ({
    ok: false,
    error: "mid-turn, try --now",
  }));

  try {
    assert.deepEqual(
      await requestSupervisorControl("refuser", {
        kind: "stop",
        mode: "graceful",
      }),
      {
        handle: "refuser",
        ok: false,
        reason: "refused",
        error: "mid-turn, try --now",
      },
    );
  } finally {
    await l.close();
  }
});

test("a refusal with no reason still reads as a refusal, not as silence", async () => {
  const l = await WakeListener.bind("mute", () => ({ ok: false }));

  try {
    const r = await requestSupervisorControl("mute", {
      kind: "stop",
      mode: "now",
    });

    assert.equal(r.ok, false);
    assert.equal(r.error, "no reason given");
  } finally {
    await l.close();
  }
});

test("an accepted stop carries the SUPERVISOR's own grace, not a local default", async () => {
  // 🛑 `shutdownGraceSeconds` is overridable per handle, so a caller computing
  // its wait ceiling from the default gives up first and calls a healthy stop
  // a failure. Found by claude2 reviewing PR #158.
  const l = await WakeListener.bind("patient", () => ({
    ok: true,
    graceSeconds: 90,
  }));

  try {
    assert.deepEqual(
      await requestSupervisorControl("patient", {
        kind: "stop",
        mode: "graceful",
      }),
      { handle: "patient", ok: true, graceSeconds: 90 },
    );
  } finally {
    await l.close();
  }
});

test("an ack with no grace omits the field rather than inventing one", async () => {
  const l = await WakeListener.bind("terse", () => ({ ok: true }));

  try {
    const r = await requestSupervisorControl("terse", {
      kind: "restart",
      mode: "now",
    });

    assert.deepEqual(r, { handle: "terse", ok: true });
  } finally {
    await l.close();
  }
});

test("the control reaches the supervisor verbatim, kind and mode both", async () => {
  const seen: unknown[] = [];
  const l = await WakeListener.bind("listener", (e) => {
    seen.push(e.control);

    return { ok: true };
  });

  try {
    await requestSupervisorControl("listener", {
      kind: "restart",
      mode: "now",
    });

    assert.deepEqual(seen, [{ kind: "restart", mode: "now" }]);
  } finally {
    await l.close();
  }
});

test("the two failures are told apart by `reason`, not by their wording", async () => {
  // 🛑 THE DISCRIMINANT IS WHAT THE CLI BRANCHES ON. It printed the wrong
  // sentence for a refusal if `error`'s wording ever changed, because it
  // string-compared the prose built in another file. Found by claude1 on
  // PR 296. This asserts the two failures differ STRUCTURALLY.
  const refusing = await WakeListener.bind("says-no", () => ({ ok: false }));

  try {
    const unreachable = await requestSupervisorControl("not-there", {
      kind: "stop",
      mode: "graceful",
    });
    const refused = await requestSupervisorControl("says-no", {
      kind: "stop",
      mode: "graceful",
    });

    assert.equal(unreachable.reason, "unreachable");
    assert.equal(refused.reason, "refused");
    assert.notEqual(unreachable.reason, refused.reason);
  } finally {
    await refusing.close();
  }
});

test("a success carries no `reason` at all", async () => {
  const l = await WakeListener.bind("fine", () => ({ ok: true }));

  try {
    const r = await requestSupervisorControl("fine", {
      kind: "stop",
      mode: "graceful",
    });

    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
  } finally {
    await l.close();
  }
});
