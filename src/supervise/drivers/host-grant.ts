import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ChildGrant } from "../grant.js";
import type { VendorSpawn } from "../vendor.js";
import { realContains } from "../containment.js";
import { assertHandle } from "../../util/naming.js";
import { writePrivateFileSync } from "../../util/paths.js";
import { CHAT_MCP_SERVER_ID, chatMcpServerConfig } from "./chat-mcp-server.js";
import { readVendorToken } from "../auth.js";

/**
 * The three fields a file-delivered host grant actually reads.
 *
 * ⚠️ `Pick` REACHES `hostGrantConfigPath` DIRECTLY, with no intersection. An
 * earlier cut restated the field in an `&` clause, which only repeated what
 * `VendorSpawn` already declares optional — and did so twice.
 */
type HostGrantFileVendor = Pick<
  VendorSpawn,
  "vendor" | "hostGrantDelivery" | "hostGrantConfigPath"
>;

/**
 * Where a `"file"`-delivered host grant is written, resolved against the
 * agent's own cwd.
 *
 * 🛑 THIS IS NOT `mcpConfigFor`, AND THAT IS NOT A DUPLICATE. `mcpConfigFor`
 * takes a grant and a mode and has no cwd to resolve against, so it cannot
 * express a project-local location at all — its host arm returned the state
 * dir, which is the path `cursor-agent` never reads and the whole of #348.
 *
 * ⚠️ DECLARING `"file"` AND PROVIDING NO RESOLVER THROWS, because
 * `assertHostGrantReachesBus` admits `"file"` by NOT being `"none"`. Without
 * this the field could be flipped, the writer forgotten, and the refusal would
 * simply stop firing — returning the agent to the silence #348 exists to end.
 * claude1's 🔵 on PR 387.
 */
export function hostGrantConfigPathFor(
  vendor: HostGrantFileVendor,
  cwd: string,
): string {
  if (!vendor.hostGrantConfigPath) {
    throw new Error(
      `vendor "${vendor.vendor}" declares hostGrantDelivery "file" and provides no ` +
        `hostGrantConfigPath, so nothing says WHERE to write the grant. The declaration ` +
        `alone makes assertHostGrantReachesBus stop refusing this vendor, which would ` +
        `return it to starting cleanly and answering nothing.`,
    );
  }

  const path = vendor.hostGrantConfigPath(cwd);

  // 🛑 A RELATIVE ANSWER WOULD RESOLVE AGAINST THE SUPERVISOR'S CWD, NOT THE
  // CHILD'S. The two differ whenever an operator supervises a project other
  // than the one they are sitting in, so the file would land in this process's
  // directory and the agent would read nothing.
  if (!isAbsolute(path)) {
    throw new Error(
      `vendor "${vendor.vendor}" resolved a RELATIVE hostGrantConfigPath "${path}". It must ` +
        `be absolute: a relative path resolves against the supervisor's cwd, not the ` +
        `child's, and the two differ whenever the supervised project is not this one.`,
    );
  }

  return path;
}

/**
 * Write a host child's bus grant as the config file its CLI reads, and return
 * the path it landed at.
 *
 * 🛑 FOR A CLI WITH NO CONFIG-PATH FLAG. `cursor-agent` has none — measured on
 * #372 against the live binary's 24 long flags — so the file landing where it
 * already looks IS the entire wiring, and there is nothing for an argv to add.
 *
 * 🛑 IT REFUSES AN EXISTING FILE RATHER THAN OVERWRITING IT. lee ruled on
 * 2026-11-21 that the supervisor may write this path, and the refusal is the
 * half of that ruling that keeps an operator's own Cursor configuration. The
 * file is theirs; this project may destroy it exactly never.
 *
 * ⚠️ NO POST-WRITE `existsSync` HERE, AND ITS ABSENCE IS MEASURED. One was
 * written and then removed: `writeFileSync` throws on failure, so the check
 * was unreachable, and deleting it killed 0 of 20 tests. A guard no test can
 * reach reads as protection and is not any.
 */
export function deliverHostGrantFile(
  vendor: HostGrantFileVendor,
  grant: ChildGrant,
  cwd: string,
): string {
  // 🛑 BEFORE ANY mkdir. A vendor delivering by flags that got a directory
  // planted in the operator's project would leave a file nothing ever reads.
  if (vendor.hostGrantDelivery !== "file") {
    throw new Error(
      `vendor "${vendor.vendor}" declares hostGrantDelivery ` +
        `"${vendor.hostGrantDelivery}", so its host grant is not delivered by writing a ` +
        `file and this writer must not be called for it.`,
    );
  }

  // 🛑 ASSERTED HERE, NOT BORROWED. `grant.handle` reaches the written file,
  // and today it is already validated because `buildGrant` calls
  // `writeClaudeMcpConfig` -> `mcpConfigPathFor` -> `assertHandle` for EVERY
  // vendor first. That coupling is indirect: a change that stops writing the
  // state-dir config for a file-delivered vendor would take the validation
  // with it and nothing here would notice.
  assertHandle(grant.handle);

  const path = hostGrantConfigPathFor(vendor, cwd);

  // 🛑 CONTAINMENT FIRST, BEFORE ANYTHING READS OR REPORTS THIS PATH. Making
  // re-delivery a no-op once put an existsSync/readFileSync branch above this
  // call, and a `.cursor` symlinked OUT of the project that held our exact
  // bytes was then returned as success — the escape this guard exists to
  // refuse, waved through by the fix for a different bug.
  assertDirIsNotASymlinkEscape(cwd, path, vendor.vendor);

  const desired = `${JSON.stringify(chatMcpServerConfig(grant.handle), null, 2)}\n`;

  if (existsSync(path)) {
    // 🛑 RE-DELIVERY IS A NO-OP, NOT A REFUSAL. Nothing deletes this file, so
    // a refusal on any existing file meant a granted handle started exactly
    // ONCE per project directory and the second start blamed the operator for
    // a file the supervisor itself had written.
    if (readFileSync(path, "utf8") === desired) return path;

    // ⚠️ THE MESSAGE CLAIMS NO AUTHOR. "the supervisor did not create it" was
    // a guess stated as a fact: an older build of this project writes a
    // different entry path and lands here too.
    throw new Error(
      `refusing to overwrite ${path}: its contents are not the config this supervisor ` +
        `writes for handle "${grant.handle}". If it is yours, move it aside. If an older ` +
        `chat-mcp wrote it, delete it. Or run this handle UNGRANTED.`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });

  // 🛑 `wx`, SO THE REFUSAL ABOVE CANNOT BE RACED. The existsSync is the
  // readable error; this is the one that actually holds when two supervisors
  // reach the same project directory at once.
  //
  // ⚠️ `writePrivateFileSync` FOR 0600, MATCHING THE STATE-DIR WRITER. This
  // file holds no secret, but it lands in a project directory that may not
  // ignore it, and it names this host's absolute paths.
  writePrivateFileSync(path, desired, "wx");

  return path;
}

/**
 * Refuse to write through a symlinked directory out of the project tree.
 *
 * 🛑 `wx` GUARDS THE FILE AND NOT THE DIRECTORY ABOVE IT. `O_CREAT|O_EXCL`
 * refuses to follow a symlink planted AT `mcp.json`, and does nothing about
 * `.cursor` itself being one: `mkdirSync({recursive:true})` sees the resolved
 * directory already exists and no-ops, then `wx` succeeds, and the config
 * lands in the symlink's TARGET. Measured — a `.cursor -> /tmp/elsewhere` link
 * put the file at `/tmp/elsewhere/mcp.json`.
 *
 * 🛑 A SUPERVISED PROJECT IS NOT TRUSTED INPUT. It can ship such a symlink in
 * its own tree, and this repo's `.gitignore` protects no other repository.
 *
 * ⚠️ A SYMLINKED CWD IS LEGITIMATE AND STAYS ALLOWED. macOS `/tmp` is one, so
 * containment is judged on REAL paths rather than by banning them —
 * `realContains` is the same helper `containment.ts` uses for a manifest
 * script path, and for the same reason: `resolve` is LEXICAL and cannot see a
 * symlink.
 */
function assertDirIsNotASymlinkEscape(
  cwd: string,
  path: string,
  vendor: string,
): void {
  // 🛑 THE NEAREST EXISTING ANCESTOR, NOT THE LEAF. Returning early when the
  // config directory is absent left the escape open: `mkdirSync` with
  // `recursive` then FOLLOWS a symlinked ancestor and creates the leaf
  // outside the project. Measured — a `link -> /tmp/elsewhere` ancestor with
  // no `inner/` under it wrote to `/tmp/elsewhere/inner/mcp.json` and threw
  // nothing. claude1 on PR 389.
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);

  // ⚠️ THE CWD ITSELF MAY BE A SYMLINK AND THAT IS LEGITIMATE — macOS `/tmp`
  // is one. Only components BELOW it are judged, so a supervised project
  // under a linked path still works.
  if (realpathish(dir) === realpathish(cwd)) return;

  if (lstatSync(dir).isSymbolicLink() || !realContains(cwd, dir)) {
    throw new Error(
      `refusing to write "${vendor}"'s host grant through ${dir}: it is a symlink, or it ` +
        `resolves outside ${cwd}. The config would land in the link's target rather than ` +
        `in the supervised project, and a project directory is not trusted input. Remove ` +
        `the link, or run this handle UNGRANTED.`,
    );
  }
}

/** A real path where one exists, and the resolved name where it does not. */
function realpathish(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** The two fields the approval step reads. */
type HostGrantApproveVendor = Pick<
  VendorSpawn,
  "vendor" | "binary" | "hostGrantApproveArgs" | "authEnvVar"
>;

/**
 * Run a CLI's own approval subcommand so the config it can SEE is one it will
 * LOAD, and return the argv that was run.
 *
 * 🛑 WITHOUT THIS A GRANTED CURSOR CHILD HAS ZERO BUS TOOLS. #348 shipped with
 * the writer and without this, so its own silence survived the fix for it. The
 * measurement is on `hostGrantApproveArgs` in `vendor.ts`.
 *
 * 🛑 IN THE CHILD'S CWD, BECAUSE THE APPROVAL IS PER PROJECT. Cursor records
 * it under `~/.cursor/projects/<slug>/mcp-approvals.json`, and the slug is
 * derived from that directory's REAL path — a run in the supervisor's own
 * directory approves a different project and leaves the child deaf.
 *
 * 🛑 IT THROWS RATHER THAN WARNING. A warning leaves a child running with no
 * `send`, which is indistinguishable from #348 and from a model that chose not
 * to answer. The spawn is the last moment this is detectable.
 *
 * ⚠️ A VENDOR THAT DECLARES NO APPROVAL STEP IS A REAL ANSWER, NOT A GAP.
 * Claude's grant arrives by flags and is live at startup; `claude` has no `mcp
 * enable` subcommand, so approving unconditionally would break the vendor that
 * already worked.
 */
export function approveHostGrantServer(
  vendor: HostGrantApproveVendor,
  cwd: string,
): readonly string[] | undefined {
  if (!vendor.hostGrantApproveArgs) return undefined;

  const args = vendor.hostGrantApproveArgs(CHAT_MCP_SERVER_ID);

  try {
    execFileSync(vendor.binary, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // 🛑 THE CLI's OWN STDERR IS THE ACTIONABLE HALF. "Command failed" sends
    // the operator to the spawn layer; the CLI says whether the id is unknown,
    // the binary is missing, or the config was never read.
    const detail = detailOf(err, readVendorToken(vendor));

    throw new Error(
      `"${vendor.vendor}"'s bus server "${CHAT_MCP_SERVER_ID}" could not be APPROVED in ${cwd}, ` +
        `so the child would have started with no bus tools at all — it would answer nothing ` +
        `and say nothing. Ran: ${vendor.binary} ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
    );
  }

  return args;
}

/**
 * Whatever the failed CLI said, preferring stderr over the thrown message, with
 * the vendor's own credential removed.
 *
 * 🛑 THE STDERR IS THE VENDOR'S TEXT, NOT OURS, AND IT LANDS IN A THROWN ERROR
 * THAT REACHES LOGS AND CHAT. A CLI whose auth diagnostics echo part of a key
 * would put it there, so the token is substituted out rather than trusted to be
 * absent. claude2's security reviewer on PR 394.
 *
 * ⚠️ IT REDACTS A VALUE IT KNOWS, AND CANNOT REDACT ONE IT DOES NOT. This is a
 * floor, not a guarantee: a CLI printing a DIFFERENT secret is still unhandled,
 * which is why `stdio` keeps stderr piped rather than inherited.
 */
function detailOf(err: unknown, secret: string | null | undefined): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  const text =
    stderr || (typeof e?.message === "string" ? e.message : String(err));

  // A short or empty token would match everywhere and redact the whole message.
  if (!secret || secret.length < 8) return text;

  return text.replaceAll(secret, "«redacted»");
}

/** `.cursor/mcp.json` under a project directory, which is what Cursor reads. */
export function cursorProjectMcpConfigPath(cwd: string): string {
  return join(cwd, ".cursor", "mcp.json");
}
