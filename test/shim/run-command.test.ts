import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-tools-"));

const { registerProject } = await import("../../src/supervise/projects.js");
const { ensureManifestDir, manifestPathFor } =
  await import("../../src/util/paths.js");
const { Refusal } = await import("../../src/supervise/run-command-service.js");
const { COULD_NOT_RUN, answerFor, installRunCommand } =
  await import("../../src/shim/tools/run_command.js");

const MANIFEST = {
  commands: [
    {
      name: "gate",
      script: "scripts/gate.sh",
      params: [{ name: "lane", type: "enum", values: ["php", "js"] }],
    },
    { name: "boom", script: "scripts/boom.sh", params: [] },
  ],
};

const handleFor = (name: string) => `${name}-${process.pid}`;

/** A project directory with two runnable scripts, plus its manifest in the store. */
function projectFor(handle: string): void {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-tools-project-"));

  mkdirSync(join(dir, "scripts"), { recursive: true });

  const gate = join(dir, "scripts", "gate.sh");
  writeFileSync(gate, '#!/bin/sh\necho "lane=$1"\n');
  chmodSync(gate, 0o755);

  // Exists so a NON-ZERO EXIT has its own command. A failing command is a
  // RESULT, and the test below separates it from a refusal.
  const boom = join(dir, "scripts", "boom.sh");
  writeFileSync(boom, "#!/bin/sh\necho out\necho err >&2\nexit 3\n");
  chmodSync(boom, 0o755);

  registerProject(handle, dir);
  ensureManifestDir();
  writeFileSync(
    manifestPathFor(handle),
    JSON.stringify({ projectDir: dir, ...MANIFEST }),
  );
}

type Handler = (args: {
  name: string;
  params?: Record<string, string>;
}) => Promise<{
  content: { text: string }[];
}>;

/**
 * 🛑 THE TESTS DRIVE THE REGISTERED HANDLERS, NOT THE SERVICE. Calling
 * `listCommandsFor` directly would pass on a tool wired to the wrong handle,
 * which is the one thing the move off the broker could break.
 */
function toolsFor(handle: string): {
  names: string[];
  call: (tool: string, args?: object) => Promise<Record<string, unknown>>;
} {
  const names: string[] = [];
  const handlers = new Map<string, Handler>();

  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      names.push(name);
      handlers.set(name, handler);
    },
  };

  installRunCommand(
    server as unknown as Parameters<typeof installRunCommand>[0],
    { handle } as Parameters<typeof installRunCommand>[1],
  );

  const call = async (tool: string, args: object = {}) => {
    const handler = handlers.get(tool);

    assert.ok(handler, `${tool} was never registered`);

    const reply = await handler(args as Parameters<Handler>[0]);

    return JSON.parse(reply.content[0].text) as Record<string, unknown>;
  };

  return { names, call };
}

// ---------------------------------------------------------------------------
// The CONTROL comes first. Without it every refusal test below would pass on a
// tool that failed on everything.
// ---------------------------------------------------------------------------

test("CONTROL — the tools list the manifest commands and run one, in process", async () => {
  const handle = handleFor("control");

  projectFor(handle);

  const { call } = toolsFor(handle);
  const listed = await call("list_commands");

  assert.equal(listed.ok, true);
  assert.deepEqual(
    (listed.commands as { name: string }[]).map((c) => c.name),
    ["gate", "boom"],
  );

  const ran = await call("run_command", {
    name: "gate",
    params: { lane: "php" },
  });

  assert.equal(ran.ok, true);
  assert.equal(ran.exitCode, 0);
  assert.equal(ran.stdout, "lane=php\n");
});

// ---------------------------------------------------------------------------
// Option B — the refusal IS the capability check, so it must name its cause
// ---------------------------------------------------------------------------

test("🛑 NO MANIFEST IS A REFUSAL, NOT A MISSING TOOL — and it says which", async () => {
  const { call } = toolsFor(handleFor("nomanifest"));
  const reply = await call("list_commands");

  assert.equal(reply.ok, false);
  assert.equal(reply.error, "this agent has no usable command manifest");
});

test("🛑 BOTH TOOLS REGISTER WITH NO MANIFEST AT ALL", () => {
  const { names } = toolsFor(handleFor("registration"));

  assert.deepEqual(names, ["list_commands", "run_command"]);
});

test("a refusal carries its own sentence and never a host path", async () => {
  const handle = handleFor("refusal");

  projectFor(handle);

  const { call } = toolsFor(handle);
  const reply = await call("run_command", {
    name: "no-such-command",
    params: {},
  });

  assert.equal(reply.ok, false);
  assert.equal(typeof reply.error, "string");
  assert.doesNotMatch(reply.error as string, /\/(private\/)?(var|tmp)\//);
});

// ---------------------------------------------------------------------------
// The distinction a single `ok` flag is most likely to lose
// ---------------------------------------------------------------------------

test("🛑 A NON-ZERO EXIT IS A RESULT, NOT A REFUSAL — ok stays true", async () => {
  const handle = handleFor("nonzero");

  projectFor(handle);

  const { call } = toolsFor(handle);
  const reply = await call("run_command", { name: "boom", params: {} });

  assert.equal(
    reply.ok,
    true,
    "a command that exited 3 must not read as a refusal",
  );
  assert.equal(reply.exitCode, 3);
  assert.equal(reply.stdout, "out\n");
  assert.equal(reply.stderr, "err\n");
});

// ---------------------------------------------------------------------------
// Disclosure — only a sentence written FOR the caller may cross
// ---------------------------------------------------------------------------

test("⚠️ CONTROL — a Refusal’s public message IS passed through", async () => {
  const reply = await answerFor(handleFor("discloses"), () => {
    throw new Refusal(
      "the command was refused",
      new Error("/private/var/secret"),
    );
  });

  assert.equal(reply.ok, false);
  assert.equal(reply.error, "the command was refused");
});

test("🛑 ANYTHING THAT IS NOT A REFUSAL IS NOT DISCLOSED", async () => {
  const reply = await answerFor(handleFor("undisclosed"), () => {
    throw new Error("ENOENT: open /private/var/folders/host/path");
  });

  assert.equal(reply.ok, false);
  assert.equal(reply.error, COULD_NOT_RUN);
});

test("🛑 THE ENVELOPE WINS — a payload carrying its own `ok` cannot overwrite it", async () => {
  const reply = await answerFor(
    handleFor("envelope"),
    () =>
      // Cast because no current payload has an `ok`. The point is that one
      // gaining it later must not flip the caller's refusal-vs-result signal.
      ({ ok: false, exitCode: 0, stdout: "", stderr: "" }) as never,
  );

  assert.equal(reply.ok, true);
  assert.equal(reply.exitCode, 0);
});
