import { existsSync, readFileSync } from "node:fs";
import { overridePathFor, profilePathFor } from "../util/paths.js";
import {
  mergeOverrides,
  parseHandleOverride,
  parseProfile,
  type ContainerOverride,
  type HandleOverride,
} from "./overrides.js";

/**
 * Reads the two override files off disk and resolves them into one value.
 *
 * 🛑 A SEPARATE FILE FROM `overrides.ts` SO THAT ONE STAYS PURE. That module is
 * the key allowlists, every value check and the merge, and it is the module a
 * reviewer reads to answer "what may a human write". Mixing `readFileSync` into
 * it means every test of a value check needs a temp directory.
 *
 * 🛑 NO WRITER HERE, AND NO `ensureProfilesDir`. Nothing in this unit creates
 * either directory. A reader that creates what it is about to read cannot tell
 * "no capabilities configured" from "the operator's file is missing".
 */

/**
 * The refusal for a name with no file, in one place.
 *
 * 🛑 IT NAMES THE PATH, NOT JUST THE NAME. The reader derives the path from
 * `stateDir()`, so an operator who wrote the file into the wrong tree sees a
 * name they recognise and a location they do not — which is the actual fault.
 */
function missingProfileRefusal(name: string, forHandle: string | null): string {
  const asked =
    forHandle === null
      ? `no such container profile "${name}"`
      : `"${forHandle}" points at container profile "${name}", which does not exist`;

  return (
    `${asked}: nothing at ${profilePathFor(name)}. ` +
    "Refusing rather than spawning without the capabilities the profile names."
  );
}

/**
 * Parse one override file, or throw naming the file.
 *
 * 🛑 MALFORMED THROWS, UNLIKE `readProjects` AND `readMounts`. Those two
 * read empty on purpose, because `dirsFor` reports an empty registration
 * loudly. Here an empty read means "no capabilities" and is byte-identical to
 * the normal no-file case, so a stray comma would start an agent without the
 * grant its operator wrote down and nothing would say so.
 *
 * 🛑 THE PATH IS IN THE MESSAGE. `JSON.parse`'s own error says "Unexpected
 * token" and names no file, and there are two directories it could be in.
 */
function parseFile<T>(path: string, parse: (raw: unknown) => T): T {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  try {
    return parse(raw);
  } catch (err) {
    throw new Error(`refusing ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * One shared profile's container keys, or throw.
 *
 * 🛑 A MISSING PROFILE THROWS, UNLIKE A MISSING HANDLE FILE. A handle with no
 * file wants the default container. A handle that NAMES a profile has asked
 * for something specific, so falling back would show the operator a capability
 * the agent did not get.
 *
 * 🛑 `forHandle` CHANGES THE REFUSAL SENTENCE AND NOTHING ELSE. It exists so
 * `resolveOverrideFor` can name who asked without a second copy of
 * exists-then-parse. The copy was there, and the one with tests was the one no
 * spawn would ever reach — so a later hardening here, a size cap or a mode
 * check, would have missed the path that matters. Found by claude2 on PR 334.
 */
export function readProfile(
  name: string,
  forHandle: string | null = null,
): ContainerOverride {
  const path = profilePathFor(name);

  if (!existsSync(path)) {
    throw new Error(missingProfileRefusal(name, forHandle));
  }

  return parseFile(path, parseProfile);
}

/**
 * One handle's own override file, or `null` when it has no file.
 *
 * ⚠️ `null` IS THE NORMAL CASE, NOT AN ERROR. Every agent that wants the
 * default container has no file here.
 */
export function readHandleOverride(handle: string): HandleOverride | null {
  const path = overridePathFor(handle);

  if (!existsSync(path)) return null;

  return parseFile(path, parseHandleOverride);
}

/**
 * The container override a handle actually gets, or `null` when it has none.
 *
 * 🛑 THE POINTER IS RESOLVED HERE AND DOES NOT SURVIVE. `mergeOverrides`
 * returns the five container keys, so `profile` never reaches a spawn.
 *
 * 🛑 PROFILE FIRST, HANDLE SECOND, BY NAME. The arguments are named rather than
 * positional because a transposed positional call type-checked and silently
 * inverted lee's ADD-only ruling.
 */
export function resolveOverrideFor(handle: string): ContainerOverride | null {
  const own = readHandleOverride(handle);

  if (own === null) return null;

  const { profile: pointer, ...container } = own;

  if (pointer === undefined) return container;

  return mergeOverrides({
    profile: readProfile(pointer, handle),
    handle: own,
  });
}
