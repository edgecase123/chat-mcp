import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

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

export type ParamType = 'enum' | 'string';

export interface CommandParam {
  readonly name: string;
  readonly type: ParamType;
  /** Required for `enum`, refused for `string`. */
  readonly values?: readonly string[];
  /** Omitted makes the param required. */
  readonly default?: string;
}

export interface CommandSpec {
  readonly name: string;
  /** Relative to the project directory, normalised, contained. */
  readonly script: string;
  readonly params?: readonly CommandParam[];
}

export interface CommandManifest {
  readonly commands: readonly CommandSpec[];
}

/** What an agent is told. Deliberately missing `script`. */
export interface ListedCommand {
  readonly name: string;
  readonly params: readonly CommandParam[];
}

export interface ResolvedCommand {
  readonly script: string;
  readonly argv: readonly string[];
}

const PARAM_TYPES: readonly ParamType[] = ['enum', 'string'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse a script path that is absolute or that leaves the project.
 *
 * 🛑 NORMALISE FIRST. `scripts/../../bin/sh` does not begin with `..` but
 * resolves outside, so a prefix check on the raw string reads it as
 * contained. The normalised form is what gets stored and run.
 */
function containedScript(commandName: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`command "${commandName}" needs a non-empty "script"`);
  }

  if (isAbsolute(raw)) {
    throw new Error(`command "${commandName}" script must be a relative path, got "${raw}"`);
  }

  const normalised = normalize(raw);

  if (normalised === '..' || normalised.startsWith(`..${'/'}`)) {
    throw new Error(
      `command "${commandName}" script must stay inside the project, got "${raw}"`,
    );
  }

  return normalised;
}

function parseParam(commandName: string, raw: unknown): CommandParam {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error(`command "${commandName}" has a param with no name`);
  }

  const name = raw.name;

  if (typeof raw.type !== 'string' || !PARAM_TYPES.includes(raw.type as ParamType)) {
    throw new Error(
      `command "${commandName}" param "${name}": unknown param type ${JSON.stringify(raw.type)}`,
    );
  }

  const type = raw.type as ParamType;
  let values: readonly string[] | undefined;

  if (type === 'enum') {
    if (!Array.isArray(raw.values) || raw.values.length === 0) {
      throw new Error(
        `command "${commandName}" param "${name}" is an enum and needs a non-empty "values" array`,
      );
    }

    if (!raw.values.every((v): v is string => typeof v === 'string')) {
      throw new Error(`command "${commandName}" param "${name}": every value must be a string`);
    }

    values = [...(raw.values as string[])];
  } else if (raw.values !== undefined) {
    throw new Error(`command "${commandName}" param "${name}" is a string and takes no "values"`);
  }

  let fallback: string | undefined;

  if (raw.default !== undefined) {
    if (typeof raw.default !== 'string') {
      throw new Error(`command "${commandName}" param "${name}": default must be a string`);
    }

    fallback = raw.default;

    if (values && !values.includes(fallback)) {
      throw new Error(
        `command "${commandName}" param "${name}": default "${fallback}" is not one of ${values.join(', ')}`,
      );
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
  const seen = new Set<string>();

  for (const param of params) {
    if (seen.has(param.name)) {
      throw new Error(`command "${name}" has a duplicate param "${param.name}"`);
    }
    seen.add(param.name);
  }

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

  const commands = raw.commands.map(parseCommand);
  const seen = new Set<string>();

  for (const command of commands) {
    if (seen.has(command.name)) {
      throw new Error(`duplicate command "${command.name}" in the manifest`);
    }
    seen.add(command.name);
  }

  return { commands };
}

/**
 * Read and validate a manifest from disk.
 *
 * 🛑 THROWS ON A MALFORMED FILE, unlike `projects.json` and `mounts.json`
 * which read as empty. Those two degrade to "nothing registered", which is
 * safe. A manifest that silently reads as empty would present itself as
 * "this project offers no commands" and send the operator looking at the
 * broker instead of at their stray comma.
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
  return manifest.commands.map((command) => ({
    name: command.name,
    params: command.params ?? [],
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
    const supplied = params[param.name];

    if (supplied === undefined) {
      if (param.default !== undefined) return param.default;
      throw new Error(`command "${name}" needs a value for "${param.name}"`);
    }

    if (typeof supplied !== 'string') {
      throw new Error(`command "${name}" param "${param.name}" must be a string`);
    }

    if (param.values && !param.values.includes(supplied)) {
      throw new Error(
        `command "${name}" param "${param.name}": "${supplied}" is not one of ${param.values.join(', ')}`,
      );
    }

    return supplied;
  });

  return { script: command.script, argv };
}
