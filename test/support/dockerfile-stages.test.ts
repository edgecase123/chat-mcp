import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_VENDORS,
  dockerfileText,
  stageDirectives,
  stageLineage,
  vendorStagesIn,
} from "./dockerfile-stages.js";

/**
 * The helper three Dockerfile suites index through, so its own blindness would
 * be invisible in all three.
 *
 * 🛑 FIXTURES, NOT THE REPO'S DOCKERFILE. A test that reads the real file
 * proves only that today's file parses, and the defect this helper exists to
 * catch is a line MOVED INTO A STAGE NOTHING REACHES. That has to be
 * constructed.
 */

/** The real file's shape, reduced to one marker instruction per stage. */
const MULTI_STAGE = [
  "ARG AGENT_VENDOR=claude",
  "FROM node:22-slim AS base",
  "RUN in-base",
  "FROM base AS cli-claude",
  "RUN in-claude",
  "FROM base AS cli-cursor",
  "RUN in-cursor",
  "FROM cli-${AGENT_VENDOR} AS final",
  "RUN in-final",
].join("\n");

test("🛑 an instruction in a stage the build does not reach is ABSENT, which plain text cannot express", () => {
  assert.deepEqual(stageDirectives(MULTI_STAGE, "claude"), [
    "RUN in-base",
    "RUN in-claude",
    "RUN in-final",
  ]);
  assert.deepEqual(stageDirectives(MULTI_STAGE, "cursor"), [
    "RUN in-base",
    "RUN in-cursor",
    "RUN in-final",
  ]);
});

/**
 * ⚠️ THE CONTROL FOR THE TEST ABOVE. Both calls returning the same three
 * directives would also satisfy a `deepEqual` written against one vendor, so
 * the exclusion is only proven if the two results actually differ.
 */
test("⚠️ control — the two vendors reach DIFFERENT stages, so a per-vendor assertion is not run twice over one image", () => {
  assert.deepEqual(stageLineage(MULTI_STAGE, "claude"), [
    "base",
    "cli-claude",
    "final",
  ]);
  assert.deepEqual(stageLineage(MULTI_STAGE, "cursor"), [
    "base",
    "cli-cursor",
    "final",
  ]);
});

/**
 * 🛑 BUILD ORDER, NOT FILE ORDER. `cli-cursor` is written BELOW `cli-claude`,
 * so a `findIndex` over the file puts a cursor instruction after every claude
 * one. In the build they are siblings and neither runs for the other's image.
 */
test("🛑 the order returned is the order the build runs, so an index comparison means something again", () => {
  const claude = stageDirectives(MULTI_STAGE, "claude");

  assert.ok(
    claude.indexOf("RUN in-base") < claude.indexOf("RUN in-claude"),
    "the base stage's instructions must come first",
  );
  assert.equal(
    claude.indexOf("RUN in-cursor"),
    -1,
    "a sibling stage's instruction must not appear at all",
  );
});

/**
 * 🛑 THROWING IS THE REQUIREMENT. Returning the directives it could resolve
 * would truncate the lineage at the dynamic `FROM` — dropping `base` and the
 * vendor stage — and every assertion would then pass over `final` alone.
 */
test("🛑 an unresolvable vendor stage THROWS, instead of silently returning a short lineage", () => {
  assert.throws(
    () => stageDirectives(MULTI_STAGE, "nosuchvendor" as "claude"),
    /declares no stage "cli-nosuchvendor"/,
  );
});

test("🛑 a Dockerfile with no FROM throws rather than reporting an empty build", () => {
  assert.throws(() => stageDirectives("RUN nothing", "claude"), /no FROM/);
});

/** Single-stage files still work, so the helper is not multi-stage-only. */
test("a single-stage Dockerfile returns its directives unchanged", () => {
  assert.deepEqual(
    stageDirectives("FROM node:22-slim\nRUN one\nUSER agent", "claude"),
    ["RUN one", "USER agent"],
  );
});

/**
 * 🛑 COMMENTS ARE STRIPPED BEFORE ANYTHING ELSE, AND THE VACUITY IS REAL. The
 * comment above each real instruction NAMES the strings the callers match, so
 * a comment surviving into the output passes with the instruction deleted.
 */
test("🛑 comment lines are stripped, so prose naming an instruction is not the instruction", () => {
  const commented = [
    "FROM node:22-slim AS base",
    "# RUN git config --system --add safe.directory '*'",
    "  # indented comments count too",
    "RUN real",
  ].join("\n");

  assert.deepEqual(stageDirectives(commented, "claude"), ["RUN real"]);
});

/** `\`-continuations join, so a wrapped chain is one directive to index. */
test("a backslash-continued chain is ONE directive, so ordering within it is deliberately invisible", () => {
  const wrapped = [
    "FROM node:22-slim AS base",
    "RUN apt-get update \\",
    "  && apt-get install -y git",
    "RUN after",
  ].join("\n");

  assert.deepEqual(stageDirectives(wrapped, "claude"), [
    "RUN apt-get update  && apt-get install -y git",
    "RUN after",
  ]);
});

/**
 * ⚠️ THE REPO'S OWN FILE PARSES, FOR EVERY VENDOR. This is the one assertion
 * that reads the real Dockerfile, and it is a smoke check: it proves the
 * helper's parse survives the file as written, not that the file is correct.
 */
test("⚠️ the repo's Dockerfile resolves for every vendor in AGENT_VENDORS", () => {
  for (const vendor of AGENT_VENDORS) {
    const directives = stageDirectives(dockerfileText(), vendor);

    assert.ok(
      directives.length > 10,
      `${vendor}: resolved only ${directives.length} directives, which is too few to be the whole image`,
    );
  }
});

/**
 * 🛑 THE CONTROL FOR `stageLineage`'s REWRITE. It used to rebuild the lineage by
 * testing each stage's directives for membership in the flattened STRING set,
 * so one directive shared between siblings named a stage the build never
 * visited. `WORKDIR /app` in both vendor stages is all it took.
 *
 * ⚠️ IT FAILED SAFE, WHICH IS WHY IT WAS A 🟡 AND NOT A 🔴 — over-reporting made
 * the two lineages look identical, so the control went RED. Raised by claude1.
 */
const SHARED_DIRECTIVE = [
  "ARG AGENT_VENDOR=claude",
  "FROM node:22-slim AS base",
  "RUN in-base",
  "FROM base AS cli-claude",
  "WORKDIR /app",
  "RUN in-claude",
  "FROM base AS cli-cursor",
  "WORKDIR /app",
  "RUN in-cursor",
  "FROM cli-${AGENT_VENDOR} AS final",
  "RUN in-final",
].join("\n");

test("🛑 a directive duplicated across sibling stages does not put the unreached one in the lineage", () => {
  assert.deepEqual(stageLineage(SHARED_DIRECTIVE, "claude"), [
    "base",
    "cli-claude",
    "final",
  ]);
  assert.deepEqual(stageLineage(SHARED_DIRECTIVE, "cursor"), [
    "base",
    "cli-cursor",
    "final",
  ]);
});

test("⚠️ control — the duplicated directive really is in both stages, so the fixture tests what it claims", () => {
  assert.equal(
    [...SHARED_DIRECTIVE.matchAll(/^WORKDIR \/app$/gm)].length,
    2,
    "the fixture must contain the same directive twice, or it proves nothing",
  );
  assert.equal(
    stageDirectives(SHARED_DIRECTIVE, "claude").filter(
      (d) => d === "WORKDIR /app",
    ).length,
    1,
    "only the reached copy may appear in the flattened lineage",
  );
});

/**
 * 🛑 ZERO VENDOR STAGES MUST THROW. Three suites loop over `AGENT_VENDORS`, so a
 * parse that found nothing would emit no tests at all and every one of them
 * would report green.
 */
test("🛑 a Dockerfile with no cli-<vendor> stage throws, rather than yielding an empty vendor list", () => {
  assert.throws(
    () => vendorStagesIn("FROM node:22-slim AS base\nRUN one"),
    /no `AS cli-<vendor>` stage/,
  );
});

test("⚠️ control — the same parse finds both vendors in the repo's own Dockerfile", () => {
  assert.deepEqual([...vendorStagesIn(dockerfileText())].sort(), [
    "claude",
    "cursor",
  ]);
  assert.deepEqual([...AGENT_VENDORS].sort(), ["claude", "cursor"]);
});
