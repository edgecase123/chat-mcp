import { test } from "node:test";
import assert from "node:assert/strict";
import { childGrant } from "./child-grant.js";

/**
 * 🛑 THE HOST DRIVER READS ALL THREE LIST FIELDS AND THE DOCKER DRIVER READS
 * NONE. `drivers/claude.ts` calls `.length` on `available` and `extraDirs` and
 * `.join` on `allowed`, so the six literals this factory replaces would have
 * thrown a TypeError there rather than failed an assertion.
 */

test("🛑 it supplies the three list fields a bare literal omits", () => {
  const grant = childGrant({ handle: "h1", configPath: "/c.json" });

  assert.deepEqual(grant.allowed, []);
  assert.deepEqual(grant.available, []);
  assert.deepEqual(grant.extraDirs, []);
});

test("the caller's handle and config path are never defaulted", () => {
  const grant = childGrant({ handle: "h1", configPath: "/c.json" });

  assert.equal(grant.handle, "h1");
  assert.equal(grant.configPath, "/c.json");
});

test("a caller's own list wins over the empty default", () => {
  const grant = childGrant({
    handle: "h1",
    configPath: "/c.json",
    available: ["Bash"],
  });

  assert.deepEqual(grant.available, ["Bash"]);
});

/**
 * ⚠️ CONTROL — the spread order is what makes the override win. Reversing it
 * would green every test above except this one.
 */
test("⚠️ control — an explicitly empty list is indistinguishable from the default", () => {
  const defaulted = childGrant({ handle: "h1", configPath: "/c.json" });
  const explicit = childGrant({
    handle: "h1",
    configPath: "/c.json",
    allowed: [],
  });

  assert.deepEqual(defaulted, explicit);
});
