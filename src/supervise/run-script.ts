import { execFile } from 'node:child_process';

export interface ScriptResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunScriptOptions {
  readonly cwd: string;
  readonly timeout: number;
  readonly maxBuffer: number;
}

type ScriptFailure = Error & { code?: number | string; killed?: boolean };

/**
 * The seam a test substitutes, so the three classification rules below are
 * reachable without a socket and a script that really emits megabytes.
 *
 * The default-parameter form is this repo's established pattern — see
 * `imageNeedsBuild(run: Runner = realExecFileSync)` in `container.ts`.
 */
export type ScriptRunner = (
  file: string,
  args: readonly string[],
  options: RunScriptOptions,
  callback: (err: ScriptFailure | null, stdout: string, stderr: string) => void,
) => void;

const realRunner: ScriptRunner = (file, args, options, callback) => {
  execFile(file, [...args], options, callback as Parameters<typeof execFile>[3]);
};

/**
 * Run a project script and classify how it ended.
 *
 * 🛑 A NON-ZERO EXIT IS AN ANSWER, NOT AN ERROR. A gate that fails is the
 * result the caller asked for, and reporting it as a refusal would make a
 * failing gate indistinguishable from a rejected request.
 *
 * The other two endings ARE refusals: a killed child means the timeout fired,
 * and an exceeded `maxBuffer` means the output is not safe to return.
 */
export function runScript(
  script: string,
  argv: readonly string[],
  options: RunScriptOptions,
  run: ScriptRunner = realRunner,
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    run(script, argv, options, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ exitCode: 0, stdout, stderr });

        return;
      }

      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(new Error(`command output exceeded ${options.maxBuffer} bytes`));

        return;
      }

      // ⚠️ BEFORE the numeric-code arm. A timed-out child carries BOTH `killed`
      // and a code, and reading the code first would report a timeout as a
      // legitimate non-zero exit.
      if (err.killed === true) {
        reject(new Error(`command timed out after ${options.timeout}ms`));

        return;
      }

      if (typeof err.code === 'number') {
        resolve({ exitCode: err.code, stdout, stderr });

        return;
      }

      // 🛑 NEVER forward `err.message`. `execFile` writes the absolute script
      // path into it on a spawn failure, and `broker.ts` makes this string the
      // reply an agent inside a container reads.
      const code = typeof err.code === 'string' ? err.code : 'unknown';

      reject(new Error(`the command could not be started (${code})`));
    });
  });
}
