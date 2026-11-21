import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forgetConfirmText,
  planApproveLabel,
  planNeedsApproval,
  planVerdictClass,
  planVerdictLabel,
  loosenConfirmText,
  registrationFormError,
  registrationNotice,
  registrationRows,
  registrationsPanelEmpty,
} from "../../web/assets/logic.js";

/**
 * #132 slice 4a — the registration card's pure half.
 *
 * 🛑 THIS CARD IS NOT THE RUNNING-AGENTS PANEL. `agentRow` answers who is
 * connected now; these answer what the operator CONFIGURED. A handle can be
 * in either without being in the other, and `server.ts` says so on both
 * handlers.
 *
 * ⚠️ EVERY TEST HERE PASSES WITH THE CARD UNWIRED. The wiring is asserted
 * separately, against the source text of `app.js`.
 */

const ADMIN = ["read", "write", "admin"];
const READ_ONLY = ["read"];
const VENDORS = ["claude", "cursor"];

/**
 * Narrows `string | null`, and asserts the refusal is a MESSAGE.
 *
 * 🛑 NOT JUST A TYPE GUARD. A helper that returned null would otherwise
 * satisfy every `doesNotMatch` below, so this is the non-vacuity control for
 * each of them.
 */
function said(value: string | null, what: string): string {
  assert.notEqual(value, null, `${what} returned null instead of a message`);

  return value as string;
}

// ── rows ─────────────────────────────────────────────────────────────────

test("a row names the mode as a CONSEQUENCE, not as the stored word alone", () => {
  const rows = registrationRows(
    { agents: { contained: { vendor: "claude", mode: "docker" } } },
    ADMIN,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].handle, "contained");
  assert.equal(rows[0].vendor, "claude");
  assert.match(rows[0].mode, /docker/);
  assert.match(rows[0].mode, /contained/i);
});

test("🛑 a host row SAYS full host access, because that is what it grants", () => {
  const rows = registrationRows(
    { agents: { loose: { vendor: "cursor", mode: "host" } } },
    ADMIN,
  );

  assert.match(rows[0].mode, /host/);
  assert.match(
    rows[0].mode,
    /full host access/i,
    "the word 'host' alone does not tell an operator what it costs",
  );
});

test("🛑 a withheld mode reads as WITHHELD, never as host", () => {
  const rows = registrationRows(
    { agents: { somebody: { vendor: "claude" } } },
    READ_ONLY,
  );

  assert.match(rows[0].mode, /admin/i);
  assert.ok(
    !/full host access/i.test(rows[0].mode),
    "an absent mode must not render as the loosest one",
  );
  assert.ok(
    !/contained/i.test(rows[0].mode),
    "an absent mode must not render as the tightest one either",
  );
});

test("a non-admin row offers no Forget, because the route would 403 it", () => {
  const [row] = registrationRows(
    { agents: { somebody: { vendor: "claude" } } },
    READ_ONLY,
  );

  assert.equal(row.canForget, false);
});

test("an admin row offers Forget", () => {
  const [row] = registrationRows(
    { agents: { somebody: { vendor: "claude", mode: "host" } } },
    ADMIN,
  );

  assert.equal(row.canForget, true);
});

test("rows are ordered by handle, so the list does not reshuffle on refresh", () => {
  const rows = registrationRows(
    {
      agents: {
        zeta: { vendor: "claude", mode: "host" },
        alpha: { vendor: "cursor", mode: "docker" },
      },
    },
    ADMIN,
  );

  assert.deepEqual(
    rows.map((r) => r.handle),
    ["alpha", "zeta"],
  );
});

test("🛑 a missing payload is EMPTY, not a thrown render", () => {
  assert.deepEqual(registrationRows(undefined, ADMIN), []);
  assert.deepEqual(registrationRows({}, ADMIN), []);
});

// ── the empty and the notice ──────────────────────────────────────────────

test("🛑 the empty panel says so rather than going blank", () => {
  assert.match(registrationsPanelEmpty(), /\S/);
  assert.match(registrationsPanelEmpty(), /register/i);
});

test("🛑 a non-admin viewer is TOLD what is withheld and why", () => {
  const notice = said(registrationNotice(READ_ONLY), "registrationNotice");

  assert.match(notice, /admin/i);
  assert.match(notice, /mode/i);
});

test("an admin viewer gets no notice, because nothing is withheld", () => {
  assert.equal(registrationNotice(ADMIN), null);
});

// ── the form ─────────────────────────────────────────────────────────────

test("a complete draft has no error", () => {
  assert.equal(
    registrationFormError(
      { handle: "claude3", vendor: "claude", mode: "docker" },
      VENDORS,
    ),
    null,
  );
});

test("an empty handle is refused and the message names the field", () => {
  const err = said(
    registrationFormError(
      { handle: "   ", vendor: "claude", mode: "docker" },
      VENDORS,
    ),
    "an empty handle",
  );

  assert.match(err, /handle/i);
});

test("🛑 a vendor this build cannot spawn is refused at the FORM", () => {
  const err = said(
    registrationFormError(
      { handle: "claude3", vendor: "gemini", mode: "docker" },
      VENDORS,
    ),
    "an unspawnable vendor",
  );

  assert.match(err, /gemini/);
  assert.match(err, /claude, cursor/);
});

test("🛑 an unknown mode is refused rather than defaulting to host", () => {
  const err = said(
    registrationFormError(
      { handle: "claude3", vendor: "claude", mode: "sandbox" },
      VENDORS,
    ),
    "an unknown mode",
  );

  assert.match(err, /mode/i);
  assert.match(err, /sandbox/);
});

// ── the two confirms ─────────────────────────────────────────────────────

test("🛑 moving a handle from docker to host CONFIRMS, and says what it grants", () => {
  const text = said(
    loosenConfirmText("contained", "docker", "host"),
    "docker -> host",
  );

  assert.match(text, /contained/);
  assert.match(text, /full host access/i);
});

test("🛑 tightening does NOT confirm — the safe direction is never interrupted", () => {
  assert.equal(loosenConfirmText("contained", "host", "docker"), null);
});

test("no change confirms nothing", () => {
  assert.equal(loosenConfirmText("contained", "host", "host"), null);
  assert.equal(loosenConfirmText("contained", "docker", "docker"), null);
});

/**
 * 🛑 A NEW HANDLE IS NOT A LOOSENING. There is no recorded decision to undo,
 * and the form already shows what `host` grants. Confirming it too would make
 * the dialog routine, which is how the one that matters gets clicked through.
 */
test("registering a brand-new handle as host does not confirm", () => {
  assert.equal(loosenConfirmText("fresh", null, "host"), null);
  assert.equal(loosenConfirmText("fresh", undefined, "host"), null);
});

test("forgetting says the handle falls back to the start-time default", () => {
  const text = forgetConfirmText("contained");

  assert.match(text, /contained/);
  assert.match(text, /default/i);
});

// ── container plan verdicts (#132 slice 4b) ──────────────────────────────

/**
 * Every kind `ConfirmVerdict` carries, so a new one cannot be added to
 * `container.ts` without this list going stale loudly.
 *
 * 🛑 THE UNKNOWN ENTRY IS NOT A `ConfirmVerdict` KIND. It stands for one added
 * to the type and never added to the browser's label map, which is the drift
 * these three helpers have to fail closed on.
 */
const VERDICTS = ["confirmed", "unseen", "legacy", "changed"] as const;

test("every verdict reads as something, and only one of them reads as approved", () => {
  for (const verdict of VERDICTS) {
    assert.notEqual(
      planVerdictLabel(verdict),
      "",
      `${verdict} renders as nothing`,
    );
  }

  assert.match(planVerdictLabel("confirmed"), /approved/);
  assert.equal(planNeedsApproval("confirmed"), false);

  for (const verdict of ["unseen", "legacy", "changed"] as const) {
    assert.equal(
      planNeedsApproval(verdict),
      true,
      `${verdict} has to offer an approve control`,
    );
  }
});

test("🛑 an UNRECOGNISED verdict fails closed: it is labelled and it needs approval", () => {
  const label = planVerdictLabel("some-kind-added-later");

  assert.notEqual(label, "", "an unknown verdict must not render as silence");
  assert.ok(
    !/^container plan approved$/.test(label),
    "an unknown verdict must never read as approved",
  );
  assert.equal(planNeedsApproval("some-kind-added-later"), true);
  assert.match(
    planVerdictClass("some-kind-added-later"),
    /is-stale/,
    "an unknown verdict is the case a reader most needs flagged",
  );
});

test("🛑 a CHANGED plan is flagged, because an existing approval no longer covers it", () => {
  assert.match(planVerdictLabel("changed"), /changed/i);
  assert.match(planVerdictClass("changed"), /is-stale/);

  // ⚠️ THE NON-VACUITY CONTROL. A helper returning " is-stale" for everything
  // would satisfy the two assertions above.
  assert.equal(planVerdictClass("confirmed"), "");
  assert.equal(planVerdictClass("unseen"), "");
});

test("🛑 a RE-approval says so, so the operator knows which one is being re-taken", () => {
  assert.equal(planApproveLabel("confirmed"), null);
  assert.match(said(planApproveLabel("unseen"), "an unseen plan"), /^Approve/);

  for (const verdict of ["legacy", "changed"] as const) {
    assert.match(
      said(planApproveLabel(verdict), verdict),
      /^Re-approve/,
      `${verdict} already has a recorded approval behind it`,
    );
  }
});
