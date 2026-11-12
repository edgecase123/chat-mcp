import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { assertNoControlChars, containedRelative, type UncheckedScript } from './containment.js';

/**
 * The commands a supervised agent may ask the host to run.
 *
 * 🛑 THE MANIFEST IS THE WHOLE AUTHORIZATION SURFACE. The broker runs
 * `execFile`, never a shell, and every argv entry comes from a declared
 * param — so a value the schema does not describe cannot reach the process
 * table. `resolveArgv` refuses an undeclared param rather than dropping it,
 * because dropping it would make a typo look like a working call.
 *
 * Adding a project is a manifest file. Nothing here names a repo.
 */

/**
 * 🛑 `string` WAS HERE AND IS DELIBERATELY GONE. A free-form positional is
 * unconstrained argv, and `execFile` without a shell does NOT neutralise that:
 * the callee parses its own flags, so `-e/bin/sh`, `--upload-pack=…` and
 * `--checkpoint-action=exec=…` all reach it intact. Every real command so far
 * is an enumerated mode. A free-form type needs a mandatory anchored pattern
 * before it comes back.
 */
export type ParamType = 'enum';

export interface CommandParam {
  readonly name: string;
  readonly type: ParamType;
  /** The permitted values. Every type today is enumerated. */
  readonly values?: readonly string[];
  /** Omitted makes the param required. */
  readonly default?: string;
}

export interface CommandSpec {
  readonly name: string;
  /** Relative, normalised, and LEXICALLY contained. See `containedScript`. */
  readonly script: string;
  readonly params?: readonly CommandParam[];
}

export interface CommandManifest {
  /**
   * The directory every command in this manifest runs in. ABSOLUTE.
   *
   * 🛑 IT IS DECLARED HERE RATHER THAN READ FROM `projects.json`, because that
   * file lives inside the state directory every container mounts READ-WRITE.
   * An agent that can rewrite it points the broker at a tree of its own
   * choosing, and no read-only mount helps — it protects the scripts of
   * whichever tree gets picked, not which tree gets picked.
   *
   * `dirsFor` still decides where an AGENT works. That is a different question
   * from what the BROKER runs, and the two shared one answer.
   */
  readonly projectDir: string;

  /**
   * Project-relative paths the spawn mounts READ-ONLY, nested inside the
   * read-write project mount. Absent means none; chat-mcp ships no default.
   *
   * ⚠️ THE LIST MUST COVER WHAT THE SCRIPTS SOURCE, AND NOTHING HERE CAN
   * CHECK THAT. A declared entry script that sources a sibling leaves the
   * sibling writable unless the sibling is declared too. chat-mcp cannot know
   * what bash sources, so the completeness of this list is the project's.
   */
  readonly readOnlyPaths?: readonly string[];

  readonly commands: readonly CommandSpec[];
}

/** What an agent is told. Deliberately missing `script`. */
export interface ListedCommand {
  readonly name: string;
  readonly params: readonly CommandParam[];
}

export interface ResolvedCommand {
  /**
   * 🛑 NOT A PATH TO RUN. `checkedScriptPath(projectDir, script)` turns it
   * into one, and its object type is what makes skipping that a compile error.
   */
  readonly script: UncheckedScript;
  readonly argv: readonly string[];
}

/**
 * Per-type rules, parse-time and resolve-time in one place.
 *
 * 🛑 A `Record<ParamType, …>` SO A NEW TYPE CANNOT HALF-LAND. The two halves
 * used to sit in `parseParam` and in `resolveArgv`, and forgetting the second
 * would let a new type's value reach argv unchecked — a fail-open on the
 * authorization surface. The compiler now refuses a missing arm.
 */
interface ParamKind {
  /** Validate and return the declared `values`, or undefined when the type takes none. */
  readonly parseValues: (
    raw: Record<string, unknown>,
    context: string,
  ) => readonly string[] | undefined;
  /** Refuse a supplied value the type does not permit. */
  readonly assertValue: (value: string, param: CommandParam, context: string) => void;
}

const PARAM_KINDS: Record<ParamType, ParamKind> = {
  enum: {
    parseValues: (raw, context) => {
      if (!Array.isArray(raw.values) || raw.values.length === 0) {
        throw new Error(`${context} is an enum and needs a non-empty "values" array`);
      }

      if (!raw.values.every((v): v is string => typeof v === 'string')) {
        throw new Error(`${context}: every value must be a string`);
      }

      for (const value of raw.values as string[]) {
        // 🛑 A VALUE STARTING WITH `-` IS A FLAG TO THE CALLEE. The manifest
        // author controls this list, so this catches their mistake rather than
        // an agent's attack — but it is the same consequence either way.
        if (value.startsWith('-')) {
          throw new Error(`${context}: value "${value}" must not start with "-"`);
        }
      }

      return [...(raw.values as string[])];
    },
    assertValue: (value, param, context) => {
      if (!param.values?.includes(value)) {
        throw new Error(`${context}: "${value}" is not one of ${param.values?.join(', ')}`);
      }
    },
  },
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Refuse a repeated `name`, for whichever noun the caller is checking. */
function assertUniqueNames(
  named: readonly { readonly name: string }[],
  complain: (name: string) => string,
): void {
  const seen = new Set<string>();

  for (const item of named) {
    if (seen.has(item.name)) throw new Error(complain(item.name));
    seen.add(item.name);
  }
}

/**
 * Refuse a script path that is absolute or that LEXICALLY leaves the project.
 *
 * 🛑 THE CHECK ITSELF LIVES IN `containment.ts`, shared with the read-only
 * paths and with the spawn. It was duplicated here once, and the realpath
 * lesson that `allowlist.ts` already carried did not cross the copy.
 */
function containedScript(commandName: string, raw: unknown): string {
  return containedRelative(raw, `command "${commandName}" script`);
}

/**
 * The directory the broker runs this manifest's commands in.
 *
 * 🛑 ABSOLUTE, UNLIKE EVERY OTHER PATH HERE. A script path is relative because
 * it is resolved against this one. This one has nothing to be resolved against
 * at the only place it is read, so a relative value would resolve against the
 * supervisor's own working directory.
 */
function parseProjectDir(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('a command manifest needs a non-empty "projectDir"');
  }

  assertNoControlChars(raw, '"projectDir"');

  if (!isAbsolute(raw)) {
    throw new Error(`"projectDir" must be an absolute path, got "${raw}"`);
  }

  return normalize(raw);
}

/**
 * The declared read-only paths, canonicalised the way the spawn will use them.
 *
 * ⚠️ LEXICAL ONLY. `checkedMountPath` does the realpath work at spawn time,
 * where there is a directory on disk to resolve against. Refusing the obvious
 * shapes here means a manifest typo reports itself as a manifest error rather
 * than as a failed spawn.
 */
function parseReadOnlyPaths(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;

  if (!Array.isArray(raw)) {
    throw new Error('a command manifest\'s "readOnlyPaths" must be an array');
  }

  const noun = 'read-only path';
  // Trailing slashes stripped so the stored value is the one the spawn mounts.
  // Two spellings of one directory is how a duplicate goes unnoticed.
  const paths = raw.map((entry) => containedRelative(entry, noun).replace(/\/+$/, ''));

  for (const path of paths) {
    // `.`, `./` and `scripts/..` all land here, and mounting the root
    // read-only stops the agent editing the repo it is working in.
    if (path === '' || path === '.') {
      throw new Error(`a ${noun} may not be the project root`);
    }
  }

  const seen = new Set<string>();

  for (const path of paths) {
    if (seen.has(path)) throw new Error(`duplicate ${noun} "${path}" in the manifest`);
    seen.add(path);
  }

  return paths;
}

function parseParam(commandName: string, raw: unknown): CommandParam {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error(`command "${commandName}" has a param with no name`);
  }

  const name = raw.name;
  const context = `command "${commandName}" param "${name}"`;

  // Keeps a param out of Object.prototype's key space, and keeps a name out of
  // the shapes a callee might read as a flag.
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new Error(`${context}: a param name must match /^[a-z0-9][a-z0-9_-]*$/i`);
  }

  if (typeof raw.type !== 'string' || !Object.hasOwn(PARAM_KINDS, raw.type)) {
    throw new Error(`${context}: unknown param type ${JSON.stringify(raw.type)}`);
  }

  const type = raw.type as ParamType;
  const values = PARAM_KINDS[type].parseValues(raw, context);
  let fallback: string | undefined;

  if (raw.default !== undefined) {
    if (typeof raw.default !== 'string') {
      throw new Error(`${context}: default must be a string`);
    }

    fallback = raw.default;

    if (values && !values.includes(fallback)) {
      throw new Error(`${context}: default "${fallback}" is not one of ${values.join(', ')}`);
    }
  }

  return {
    name,
    type,
    ...(values ? { values } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
}

function parseCommand(raw: unknown): CommandSpec {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('every command needs a non-empty "name"');
  }

  const name = raw.name;
  const script = containedScript(name, raw.script);

  if (raw.params === undefined) return { name, script };

  if (!Array.isArray(raw.params)) {
    throw new Error(`command "${name}" has a "params" that is not an array`);
  }

  const params = raw.params.map((p) => parseParam(name, p));
  assertUniqueNames(params, (dup) => `command "${name}" has a duplicate param "${dup}"`);

  return { name, script, params };
}

/** Validate a parsed JSON value into a manifest, or throw saying why. */
export function parseManifest(raw: unknown): CommandManifest {
  if (!isRecord(raw)) {
    throw new Error('a command manifest must be an object');
  }

  if (!Array.isArray(raw.commands)) {
    throw new Error('a command manifest needs a "commands" array');
  }

  const projectDir = parseProjectDir(raw.projectDir);
  const readOnlyPaths = parseReadOnlyPaths(raw.readOnlyPaths);
  const commands = raw.commands.map(parseCommand);
  assertUniqueNames(commands, (dup) => `duplicate command "${dup}" in the manifest`);

  return { projectDir, ...(readOnlyPaths ? { readOnlyPaths } : {}), commands };
}

/**
 * Read and validate a manifest from disk.
 *
 * 🛑 THROWS ON A MALFORMED FILE, unlike `projects.json` and `mounts.json`
 * which read as empty. Those two degrade to "nothing registered", and
 * `dirsFor` turns that back into a loud error. Nothing does that for a
 * manifest, so an empty reading would present itself as "this project offers
 * no commands" and send the operator to the broker instead of their comma.
 */
export function readManifest(path: string): CommandManifest {
  if (!existsSync(path)) {
    throw new Error(`no command manifest at ${path}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : 'unparseable'}`,
    );
  }

  return parseManifest(parsed);
}

/**
 * The commands an agent is allowed to see: names and param schemas only.
 *
 * 🛑 NEVER THE SCRIPT PATH. The agent asks for a command by name and the
 * broker owns the mapping, so a path never crosses the boundary.
 */
export function listCommands(manifest: CommandManifest): ListedCommand[] {
  // 🛑 COPIES, NOT THE LIVE ARRAYS. `readonly` is compile-time only, so a
  // caller pushing onto the returned `params` used to add a param to the
  // manifest itself — after which `resolveArgv` accepted it.
  return manifest.commands.map((command) => ({
    name: command.name,
    params: (command.params ?? []).map((param) => ({
      ...param,
      ...(param.values ? { values: [...param.values] } : {}),
    })),
  }));
}

/**
 * Turn a named call plus its params into a script and a positional argv.
 *
 * Positional order follows the DECLARED param order, so a caller's key order
 * cannot reorder the arguments.
 */
export function resolveArgv(
  manifest: CommandManifest,
  name: string,
  params: Readonly<Record<string, string>>,
): ResolvedCommand {
  const command = manifest.commands.find((c) => c.name === name);

  if (!command) {
    throw new Error(`no command "${name}" in this project's manifest`);
  }

  const declared = command.params ?? [];
  const known = new Set(declared.map((p) => p.name));

  for (const key of Object.keys(params)) {
    if (!known.has(key)) {
      throw new Error(`command "${name}": unknown param "${key}"`);
    }
  }

  const argv = declared.map((param) => {
    const context = `command "${name}" param "${param.name}"`;
    const supplied = Object.hasOwn(params, param.name) ? params[param.name] : undefined;

    if (supplied === undefined) {
      if (param.default !== undefined) return param.default;
      throw new Error(`command "${name}" needs a value for "${param.name}"`);
    }

    if (typeof supplied !== 'string') {
      throw new Error(`${context} must be a string`);
    }

    PARAM_KINDS[param.type].assertValue(supplied, param, context);

    return supplied;
  });

  return { script: { relative: command.script }, argv };
}
