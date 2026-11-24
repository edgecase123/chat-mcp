/**
 * 🛑 NOT `*.test.ts`, SO `npm test`'S OWN GLOB NEVER PICKS IT UP. It is handed
 * to a child `node --test` by name. A throw here is what #427 does to a real
 * file: the module never finishes loading, so the tests below never run.
 */
import { test } from "node:test";

throw new Error("ERANGE: result too large, open 'fixture/lexer.mjs'");

test("never reached", () => {});
