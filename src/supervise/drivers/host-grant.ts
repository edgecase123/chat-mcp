import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ChildGrant } from "../grant.js";
import type { VendorSpawn } from "../vendor.js";
import { realContains } from "../containment.js";
import { assertHandle } from "../../util/naming.js";
import { writePrivateFileSync } from "../../util/paths.js";
import { chatMcpServerConfig } from "./chat-mcp-server.js";

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

  if (existsSync(path)) {
    throw new Error(
      `refusing to overwrite ${path}: the supervisor did not create it. That file is the ` +
        `operator's own MCP configuration. Move it aside to let a granted "${vendor.vendor}" ` +
        `child be wired to the bus, or run this handle UNGRANTED.`,
    );
  }

  assertDirIsNotASymlinkEscape(cwd, path, vendor.vendor);

  mkdirSync(dirname(path), { recursive: true });

  // 🛑 `wx`, SO THE REFUSAL ABOVE CANNOT BE RACED. The existsSync is the
  // readable error; this is the one that actually holds when two supervisors
  // reach the same project directory at once.
  //
  // ⚠️ `writePrivateFileSync` FOR 0600, MATCHING THE STATE-DIR WRITER. This
  // file holds no secret, but it lands in a project directory that may not
  // ignore it, and it names this host's absolute paths.
  writePrivateFileSync(
    path,
    `${JSON.stringify(chatMcpServerConfig(grant.handle), null, 2)}\n`,
    "wx",
  );

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
  const dir = dirname(path);

  // An absent directory is about to be created inside the project, so there is
  // nothing to resolve and nothing to escape through.
  if (!existsSync(dir)) return;

  if (lstatSync(dir).isSymbolicLink() || !realContains(cwd, dir)) {
    throw new Error(
      `refusing to write "${vendor}"'s host grant through ${dir}: it is a symlink, or it ` +
        `resolves outside ${cwd}. The config would land in the link's target rather than ` +
        `in the supervised project, and a project directory is not trusted input. Remove ` +
        `the link, or run this handle UNGRANTED.`,
    );
  }
}

/** `.cursor/mcp.json` under a project directory, which is what Cursor reads. */
export function cursorProjectMcpConfigPath(cwd: string): string {
  return join(cwd, ".cursor", "mcp.json");
}
