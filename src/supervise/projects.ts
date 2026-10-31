import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { ensureStateDir, stateDir } from '../util/paths.js';

/**
 * Which project directory each agent works in.
 *
 * 🛑 REGISTERED, NOT INFERRED, AND NOT HARDCODED. Two earlier shapes both
 * failed:
 *
 *   a constant list of three paths  -> named one agent's trees, so the other
 *                                      agent's supervisor would be REFUSED
 *   the launch directory            -> silent, and wrong the moment anyone
 *                                      starts the supervisor from elsewhere
 *
 * lee, 2026-10-31: *"we'll need to have a config that lets the user register
 * a project dir. It would probably be a cloned repo for each agent, like we
 * do now with leagues and leagues2"*.
 *
 * So the mapping is explicit and per handle, which is already how the two
 * trees are arranged:
 *
 *   claude1 -> ~/dev/leagues
 *   claude2 -> ~/dev/leagues2
 */

export interface ProjectConfig {
  /** handle -> the directories that agent may work in, most important first. */
  readonly agents: Record<string, string[]>;
}

const EMPTY: ProjectConfig = { agents: {} };

export function projectsPath(): string {
  return join(stateDir(), 'projects.json');
}

/**
 * The registered mapping, or an empty one.
 *
 * ⚠️ A MALFORMED FILE READS AS EMPTY RATHER THAN THROWING. A supervisor that
 * refuses to start because of a stray comma is worse than one that reports no
 * registration and says so — and `dirsFor` already fails loudly when nothing
 * is registered.
 */
export function readProjects(): ProjectConfig {
  const path = projectsPath();

  if (!existsSync(path)) return EMPTY;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectConfig>;

    return { agents: parsed.agents ?? {} };
  } catch {
    return EMPTY;
  }
}

/**
 * Register a directory for a handle. Returns the full list for that handle.
 *
 * 🛑 THE PATH IS RESOLVED AND MUST EXIST. A registration for a directory that
 * is not there would be refused later by `resolveCwd` with a message about
 * containment, which reads as a permissions problem rather than a typo.
 */
export function registerProject(handle: string, dir: string): string[] {
  const abs = resolve(dir);

  if (!existsSync(abs)) {
    throw new Error(`cannot register "${dir}": no such directory (resolved to ${abs})`);
  }

  const config = readProjects();
  const existing = config.agents[handle] ?? [];
  const agents = { ...config.agents, [handle]: [...new Set([...existing, abs])] };

  ensureStateDir();
  writeFileSync(projectsPath(), `${JSON.stringify({ agents }, null, 2)}\n`, 'utf8');

  return agents[handle] as string[];
}

/** Forget a handle's registration entirely. */
export function unregisterProject(handle: string): void {
  const config = readProjects();
  const agents = { ...config.agents };
  delete agents[handle];

  ensureStateDir();
  writeFileSync(projectsPath(), `${JSON.stringify({ agents }, null, 2)}\n`, 'utf8');
}

/**
 * The directories this handle may work in.
 *
 * 🛑 THROWS WHEN NOTHING IS REGISTERED, rather than falling back to
 * `process.cwd()`. A silent fallback is how a supervised agent ends up
 * pointed at whatever terminal the operator happened to be in — including a
 * sibling agent's tree — and the symptom would be edits in the wrong repo
 * rather than an error.
 */
export function dirsFor(handle: string): string[] {
  const dirs = readProjects().agents[handle];

  if (!dirs || dirs.length === 0) {
    throw new Error(
      `no project directory registered for "${handle}". ` +
        `Run: chat-mcp project set ${handle} <dir>`,
    );
  }

  return dirs;
}
