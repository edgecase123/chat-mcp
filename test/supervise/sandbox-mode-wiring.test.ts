import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-sandbox-wiring-"));

const { openHostBus } = await import("../../src/supervise/host-bus.js");
const { registerProject } = await import("../../src/supervise/projects.js");
const { ensureManifestDir, manifestPathFor } =
  await import("../../src/util/paths.js");

const PROTOCOL = "2025-06-18";

/**
 * 🛑 `runCommandFor`'s REFUSAL IS TESTED BY PASSING `sandbox` STRAIGHT IN, SO
 * NOTHING TESTED THE TWO LINES THAT SUPPLY IT. claude1 measured both mutants
 * at `0dda19b`: `host-bus.ts` `"docker"` -> `"host"` passed 2/2, and
 * `shim/index.ts` `"host"` -> `"docker"` passed 661/661. One line each, green
 * either way, and the first of them puts host execution back in a container's
 * reach.
 *
 * So these tests drive the two REAL transports and assert on a marker file the
 * command writes. The refusal text alone is the weaker assertion: a mutant
 * that lets the command through answers with something else whatever happens,
 * and the marker is the only thing that separates "refused" from "did not get
 * that far".
 */

/** A project whose one command writes `marker`, plus its manifest in the store. */
function projectFor(handle: string): { marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "cm-sandbox-wiring-project-"));
  const marker = join(dir, "ran");

  mkdirSync(join(dir, "scripts"), { recursive: true });

  // The absolute path is baked in because the runner passes no environment of
  // the test's choosing, and the marker is the whole assertion.
  const script = join(dir, "scripts", "mark.sh");
  writeFileSync(script, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
  chmodSync(script, 0o755);

  registerProject(handle, dir);
  ensureManifestDir();
  writeFileSync(
    manifestPathFor(handle),
    JSON.stringify({
      projectDir: dir,
      commands: [{ name: "mark", script: "scripts/mark.sh", params: [] }],
    }),
  );

  return { marker };
}

function rpc(method: string, params: unknown, id: number | null): string {
  return JSON.stringify(
    id === null
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id, method, params },
  );
}

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly sessionId: string | null;
}

/** POST one JSON-RPC frame and read the body ONCE. See `mcp-http.test.ts`. */
async function post(
  url: string,
  token: string,
  body: string,
  sessionId?: string,
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };

  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(url, { method: "POST", headers, body });

  return {
    status: res.status,
    text: await res.text(),
    sessionId: res.headers.get("mcp-session-id"),
  };
}

/** Initialize, acknowledge, and call `run_command` once over the host bus. */
async function callRunCommand(t: TestContext, handle: string): Promise<string> {
  const bus = await openHostBus(handle);
  t.after(() => bus.close());

  const { url, token } = bus.endpoint;

  const init = await post(
    url,
    token,
    rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "probe", version: "0" },
      },
      1,
    ),
  );

  assert.equal(init.status, 200, `initialize failed: ${init.text}`);
  assert.ok(init.sessionId, "the transport issued no mcp-session-id");

  const session = init.sessionId;

  // The SDK's server serves no request until the client acknowledges, so this
  // notification is part of the handshake and not an optional courtesy.
  await post(url, token, rpc("notifications/initialized", {}, null), session);

  const call = await post(
    url,
    token,
    rpc("tools/call", { name: "run_command", arguments: { name: "mark" } }, 2),
    session,
  );

  assert.equal(call.status, 200, `tools/call failed: ${call.text}`);

  return call.text;
}

/**
 * 🛑 THE MARKER IS THE ASSERTION, NOT THE SENTENCE. `openHostBus` serves only
 * containerized children — `startSupervisor` opens it under `isContainerSpawn`
 * and a container has no other route to the bus — so the one line that says so
 * is the whole boundary. Flip it to `"host"` and this command RUNS, on the
 * host, from a directory the agent has mounted writable.
 */
test("🚨 run_command over the HOST BUS refuses, and the script never runs", async (t) => {
  const handle = `hostbus-sandbox-${process.pid}`;
  const { marker } = projectFor(handle);

  const body = await callRunCommand(t, handle);

  assert.ok(
    !existsSync(marker),
    "the command RAN for a containerized agent — host-bus.ts is no longer " +
      'passing sandbox: "docker"',
  );

  assert.match(
    body,
    /in a container/,
    `expected the container refusal, got:\n${body}`,
  );
});

const ENTRY = new URL("../../src/index.ts", import.meta.url).pathname;

/**
 * Drive the REAL stdio shim: initialize, acknowledge, call `run_command`, and
 * resolve on its reply.
 *
 * 🛑 STDIN IS HELD OPEN UNTIL THE REPLY ARRIVES. `spawnSync` with a fixed
 * `input` sends EOF with the frames, and the shim exits on EOF — so the marker
 * would race the teardown and this test would be flaky in the direction that
 * looks like a refusal.
 */
async function callOverStdio(t: TestContext, handle: string): Promise<string> {
  const { spawn } = await import("node:child_process");

  const child = spawn(
    process.execPath,
    ["--import", "tsx", ENTRY, "--handle", handle],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CHAT_MCP_HOME: process.env.CHAT_MCP_HOME },
    },
  );

  t.after(() => child.kill("SIGKILL"));

  let out = "";
  let err = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    err += d;
  });

  const reply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `no reply to tools/call in 20s.\nstdout:\n${out}\nstderr:\n${err}`,
        ),
      );
    }, 20_000);

    child.stdout.on("data", (d: string) => {
      out += d;

      for (const line of out.split("\n")) {
        if (!line.trim()) continue;

        let frame: { id?: number };

        try {
          frame = JSON.parse(line) as { id?: number };
        } catch {
          continue;
        }

        if (frame.id === 2) {
          clearTimeout(timer);
          resolve(line);
          return;
        }
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the shim exited (${code}) before replying.\nstderr:\n${err}`,
        ),
      );
    });
  });

  child.stdin.write(
    `${rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "probe", version: "0" },
      },
      1,
    )}\n`,
  );
  child.stdin.write(`${rpc("notifications/initialized", {}, null)}\n`);
  child.stdin.write(
    `${rpc(
      "tools/call",
      { name: "run_command", arguments: { name: "mark" } },
      2,
    )}\n`,
  );

  return reply;
}

/**
 * 🛑 THE PAIRED CONTROL, AND IT IS NOT OPTIONAL. A guard that refuses every
 * agent satisfies the test above, so the host path must be shown to still WORK.
 * claude1 measured `shim/index.ts` `"host"` -> `"docker"` as 661/661 green: a
 * one-line edit took `run_command` away from every host agent and no test saw
 * it.
 *
 * ⚠️ THE MARKER IS AGAIN THE ASSERTION. Asserting the absence of the refusal
 * sentence is true however badly the shim breaks, which is the shape that let
 * the mutant through in the first place.
 */
test("🚨 run_command over the STDIO SHIM runs the script on the host", async (t) => {
  const handle = `shim-sandbox-${process.pid}`;
  const { marker } = projectFor(handle);

  const body = await callOverStdio(t, handle);

  assert.doesNotMatch(
    body,
    /in a container/,
    `the host shim was refused as containerized:\n${body}`,
  );

  assert.ok(
    existsSync(marker),
    `the command did not run on the host path:\n${body}`,
  );
});
