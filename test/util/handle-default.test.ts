import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_HANDLE,
  handleFromLoginName,
  resolveDefaultHandle,
} from "../../src/util/handle-default.js";
import { isHandle } from "../../src/util/naming.js";

/**
 * 🛑 THE BUG: TWO OPERATORS WHO NAMED THEMSELVES NOTHING WERE ONE PEER.
 *
 * The `web` and `cli` commands defaulted `--handle` to the literal `"user"`.
 * So a message addressed to either operator's real name reached nobody, and
 * the second process to start was refused by `refuseLiveRival` naming a pid
 * the operator had never heard of.
 */
test("🛑 two operators who pass no flag resolve to DIFFERENT handles, not the shared literal", () => {
  const first = resolveDefaultHandle({ readLogin: () => "leejenkins" });
  const second = resolveDefaultHandle({ readLogin: () => "ada" });

  assert.equal(first, "leejenkins");
  assert.equal(second, "ada");
  assert.notEqual(first, second);

  // The control: the fallback literal is still reachable, so the assertions
  // above are about the login name winning and not about `"user"` being gone.
  assert.equal(resolveDefaultHandle({ readLogin: () => "!!!" }), "user");
});

test("🛑 the precedence is --handle, then $CHAT_MCP_HANDLE, then the OS login", () => {
  const readLogin = () => "fromlogin";

  assert.equal(
    resolveDefaultHandle({ flag: "fromflag", env: "fromenv", readLogin }),
    "fromflag",
  );
  assert.equal(resolveDefaultHandle({ env: "fromenv", readLogin }), "fromenv");
  assert.equal(resolveDefaultHandle({ readLogin }), "fromlogin");

  // An empty string is an absent source, not a handle. Commander hands over
  // `""` for `--handle=` and a shell exports an unset var as empty.
  assert.equal(
    resolveDefaultHandle({ flag: "", env: "", readLogin }),
    "fromlogin",
  );
});

/**
 * 🛑 A NAME THE OPERATOR TYPED IS NEVER MANGLED, ONLY THE ONE THE OS CHOSE.
 *
 * Sanitising a flag would turn a typo into a silently different identity.
 * Passing it through sends it to `assertHandle`, which refuses it by name.
 */
test("🛑 a handle from the flag or the env is passed through UNSANITISED, so an illegal one is refused downstream", () => {
  assert.equal(resolveDefaultHandle({ flag: "Lee.Jenkins" }), "Lee.Jenkins");
  assert.equal(resolveDefaultHandle({ env: "Lee.Jenkins" }), "Lee.Jenkins");

  // The contrast that makes the rule visible: the SAME string as a login name
  // is sanitised into something legal.
  assert.equal(handleFromLoginName("Lee.Jenkins"), "lee-jenkins");
});

/**
 * 🛑 DECIDED by lee, 2026-11-18: *"claude2, truncate silently"*. No prompt and
 * no refusal for a login name over the limit.
 */
test("🛑 an over-long login name is truncated SILENTLY to a legal handle", () => {
  const long = "a".repeat(200);
  const got = handleFromLoginName(long);

  assert.equal(got?.length, 64);
  assert.equal(isHandle(got ?? ""), true);

  // The control: 64 is the boundary, not a blanket cut. A name already at the
  // limit is returned whole.
  assert.equal(handleFromLoginName("b".repeat(64))?.length, 64);
  assert.equal(handleFromLoginName("c".repeat(63))?.length, 63);
});

/**
 * 🛑 LOWERCASE IS A SECURITY PROPERTY, NOT A STYLE CHOICE. A handle becomes a
 * filename and macOS APFS is case-insensitive, so `Alice` and `alice` shared
 * one file and the token store answered one agent with the other's identity.
 * See `test/util/naming.test.ts`.
 */
test("🛑 every sanitised login name is a LEGAL handle, lowercase included", () => {
  const cases: Array<[string, string]> = [
    ["LeeJenkins", "leejenkins"],
    ["lee.jenkins", "lee-jenkins"],
    ["lee jenkins", "lee-jenkins"],
    ["DOMAIN\\lee", "domain-lee"],
    ["lee@example.com", "lee-example-com"],
    ["_lee", "lee"],
    ["123lee", "123lee"],
    ["lee_j-2", "lee_j-2"],
  ];

  for (const [login, want] of cases) {
    const got = handleFromLoginName(login);
    assert.equal(got, want, `handleFromLoginName(${JSON.stringify(login)})`);
    assert.equal(isHandle(got ?? ""), true, `${got} is not a legal handle`);
  }
});

test("🛑 a login name with no legal character left yields null, and the caller falls back", () => {
  for (const hopeless of ["", "!!!", "...", "---", "___"]) {
    assert.equal(
      handleFromLoginName(hopeless),
      null,
      `handleFromLoginName(${JSON.stringify(hopeless)})`,
    );
    assert.equal(
      resolveDefaultHandle({ readLogin: () => hopeless }),
      FALLBACK_HANDLE,
    );
  }
});

/**
 * ⚠️ Node documents a throw from `userInfo()` when the host has no login name
 * available. A crash there would be worse than the shared default this module
 * removes, so it falls back instead.
 */
test("⚠️ a throwing userInfo() falls back rather than crashing the server", () => {
  const got = resolveDefaultHandle({
    readLogin: () => {
      throw new Error("no login name available");
    },
  });

  assert.equal(got, FALLBACK_HANDLE);
});
