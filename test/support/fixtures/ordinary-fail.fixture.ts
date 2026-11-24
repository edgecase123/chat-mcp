/** The control: a real assertion failure, which must NOT read as a file death. */
import { test } from "node:test";
import assert from "node:assert";

test("an ordinary assertion failure", () => {
  assert.deepEqual([], [{ a: 1 }]);
});
