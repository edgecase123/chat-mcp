import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, readdir, stat, writeFile, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { openDb, type Db } from "../../storage/db.js";
import { NotifyBus, notifyPeer } from "../../notify/bus.js";
import {
  NotARoomMemberError,
  RoomSendInputError,
  sendToRoom,
} from "../../messaging/room-send.js";
import { answerAndNotify } from "../../supervise/answer.js";
import * as dao from "../../storage/dao.js";
import { parseSearch, snippet } from "../../search/query.js";
import { gaugeFreshness } from "../../shim/gauge-freshness.js";
import { rampFor } from "../../shim/context-ramp.js";
import {
  getGlobalContextGate,
  isLegalGate,
  resolveContextGate,
  resolveContextGateWithSource,
  resolveDefaultContextGate,
  setGlobalContextGate,
  setHandleContextGate,
} from "../../storage/context-gate.js";
import type { MessageKind } from "../../storage/dao.js";
import {
  assertRoomName,
  handleRefusal,
  isHandle,
  isRoomName,
} from "../../util/naming.js";
import {
  ensureStateDir,
  stateDir,
  webHandshakeFile,
  writePrivateFileSync,
} from "../../util/paths.js";
import { renderBodyToHtml } from "./render.js";
import {
  ALL_CAPABILITIES,
  COOKIE_NAME,
  HANDSHAKE_PARAM,
  cookieValue,
  mintToken,
  requiredCapability,
  sessionCookie,
  tokenMatches,
  type Capability,
} from "./credential.js";
import {
  buildHints,
  defaultRoots,
  matchesHintPrefix,
  realContainedDir,
  resolveHintQuery,
} from "./file-hints.js";
import {
  RegistrationInputError,
  readRegistrations,
  registerAgent,
  unregisterAgent,
  type AgentRegistration,
  type RegistrationConfig,
} from "../../supervise/registrations.js";
import {
  defaultStopModeFor,
  reportsContextFor,
  spawnFor,
  vendorsWithSpawn,
} from "../../adapters/index.js";
// Static, because `handleWhoami` is synchronous and needs the suffix inverse
// to look a supervised child's handle up in `agents.json` (#371).
import { childHandleFor, supervisorHandleFor } from "../../supervise/grant.js";
import { buildConfirmPlan } from "../../supervise/confirmPlan.js";
import {
  confirmVerdict,
  describeChanges,
  describePlan,
  diffPlans,
  markConfirmed,
  type ContainerPlan,
} from "../../supervise/container.js";
import { packageVersion } from "../../util/version.js";
import {
  aroundWindow,
  parseAroundId,
  parseMessageLimit,
  readerIsPartyToDm,
  targetForMessage,
} from "../../search/around.js";

const VERSION = packageVersion();

/** Well-known path where the currently-running server writes its URL so
 *  scripts + follow-up shell commands can find it without scraping stdout.
 *  Example use: `open $(cat ~/.chat-mcp/web-url)`
 *
 *  Goes through `stateDir()`, so CHAT_MCP_HOME moves it with everything else.
 *  A hardcoded `~/.chat-mcp` created a SECOND state directory at the umask
 *  mode, outside the 0700 guarantee.
 *
 *  🛑 A FUNCTION, NOT A CONST. As a module-scope `const` this resolved the
 *  state directory at IMPORT time, so merely importing this file reached the
 *  path — which made `stateDir()`'s test-runner refusal fire on any test that
 *  imports a route, and baked in whatever CHAT_MCP_HOME held at import. */
function webUrlFile(): string {
  return join(stateDir(), "web-url");
}

/** Where the static web assets live at runtime. Ships alongside the compiled
 *  server; we assume `dist/cli/web/server.js` and `web/` are siblings under
 *  the package root. */
function assetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/web -> ../../../web
  return resolve(here, "..", "..", "..", "web");
}

/** MIME lookup for the tiny set of file types we serve. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

interface ServeOptions {
  handle: string;
  port?: number;
  open?: boolean;
}

export async function runWeb(opts: ServeOptions): Promise<void> {
  const handle = opts.handle;
  const db = openDb();
  const notify = new NotifyBus(handle);
  const session_id = randomUUID();
  const token = mintToken();

  dao.upsertAgent(db, {
    handle,
    pid: process.pid,
    session_id,
    display_name: handle,
    metadata: { kind: "human", ui: "web" },
  });

  // Every connected browser tab gets its own SSE writer. When a notify fires,
  // fan out a message event to every subscriber. Tabs remove themselves from
  // the set on socket close.
  const sseClients = new Set<ServerResponse>();
  const notifyUnsub = notify.subscribe(() => {
    // Send a minimal wake event; the client re-fetches its current view via
    // /api/messages. That keeps the SSE payload cheap and lets the client
    // decide what target to sync (each tab may be looking at a different DM
    // or room).
    const frame = `event: wake\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        /* client hung up mid-write */
      }
    }
  });

  // Assigned once the socket is bound, below. Every request is served after
  // that, so the guard never sees 0.
  let boundPort = 0;
  const server = createServer(async (req, res) => {
    try {
      await route(req, res, {
        handle,
        db,
        sseClients,
        port: boundPort,
        token,
        capabilities: ALL_CAPABILITIES,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: msg }));
      }
    }
  });

  // Port selection: if --port was passed, honor it verbatim (fail if
  // taken). Otherwise try our preferred stable port first — that gives the
  // user a memorable, bookmarkable URL and lets a browser tab reconnect
  // after a restart. Fall back to an OS-assigned free port only if the
  // preferred port is taken (e.g. another chat-mcp web is already running).
  const PREFERRED_PORT = 3737;
  const actualPort = await listenWithFallback(
    server,
    opts.port,
    PREFERRED_PORT,
  );
  boundPort = actualPort;
  const url = `http://127.0.0.1:${actualPort}/`;
  // 🛑 TWO SINKS FOR THIS URL AND BOTH ARE DELIBERATE: the terminal banner for
  // the operator, and `web-handshake` at 0600 for `scripts/web` and the
  // supervisor's activity reporter. This claimed the banner was the only one,
  // on the since-corrected belief that a container can read `stateDir()`.
  // Evidence in `test/cli/web/handshake-file.test.ts`.
  //
  // `webUrlFile()` stays tokenless.
  const handshakeUrl = `${url}?${HANDSHAKE_PARAM}=${token}`;

  const banner = [
    "",
    "  ╔════════════════════════════════════════════╗",
    `  ║  chat-mcp web  ·  ${handle.padEnd(22)}    ║`,
    "  ╠════════════════════════════════════════════╣",
    `  ║  ${url.padEnd(40)}  ║`,
    "  ╚════════════════════════════════════════════╝",
    "",
    `  bound:  127.0.0.1 — NOT a containment boundary; a container reaches it`,
    `  open:   ${handshakeUrl}`,
    `  note:   that url carries this session's api credential. reopen it after a restart.`,
    `  stop:   Ctrl-C`,
    actualPort !== PREFERRED_PORT && !opts.port
      ? `  note:   preferred port ${PREFERRED_PORT} was taken — using ${actualPort} instead`
      : null,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  console.log(banner);

  // Write URL to a well-known path so external scripts can find it.
  try {
    ensureStateDir();
    await writeFile(webUrlFile(), url + "\n");
    // 🛑 THE CREDENTIAL-BEARING TWIN, 0600. `scripts/web` reads this instead of
    // scraping the startup banner out of a log — a log that `pc_log_tail`
    // reprints into a terminal transcript on any startup failure.
    writePrivateFileSync(webHandshakeFile(), handshakeUrl + "\n");
  } catch {
    /* best-effort */
  }

  if (opts.open !== false) {
    openBrowser(handshakeUrl);
  }

  // Idle-shutdown: if the last SSE client disconnected and no new one joined
  // within IDLE_TIMEOUT_MS, exit. Keeps us honest about the "no persistent
  // daemon" design principle. Reset the timer whenever a client connects.
  const IDLE_TIMEOUT_MS = 60_000;
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdleShutdown = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (sseClients.size > 0) return;
    idleTimer = setTimeout(() => {
      if (sseClients.size === 0) {
        console.log("No connected clients for 60s — exiting.");
        shutdown(0);
      }
    }, IDLE_TIMEOUT_MS);
  };
  const disarmIdleShutdown = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  // Wire the SSE client set to arm/disarm the idle timer. The `route`
  // function adds to sseClients directly; we augment via a proxy-ish set to
  // observe changes.
  const originalAdd = sseClients.add.bind(sseClients);
  const originalDelete = sseClients.delete.bind(sseClients);
  sseClients.add = (c: ServerResponse): Set<ServerResponse> => {
    const s = originalAdd(c);
    disarmIdleShutdown();
    return s;
  };
  sseClients.delete = (c: ServerResponse): boolean => {
    const ok = originalDelete(c);
    if (sseClients.size === 0) armIdleShutdown();
    return ok;
  };
  armIdleShutdown();

  /**
   * 🛑 A POLL, NOT A FILE WATCH, AND THAT IS THE POINT.
   *
   * The SSE `wake` event above is driven by `NotifyBus`, which POLLS the
   * notify file. It used to be a watch, and that watch was measured on #33 at
   * 8 of 10 signals LOST.
   * For a chat message a dropped signal costs latency, because the next wake
   * re-syncs everything. For an approval it costs correctness: the card never
   * appears, and a supervised agent sits blocked while the operator sees
   * nothing. "Nothing arrived" and "the signal was dropped" look identical,
   * which is the exact ambiguity #33 exists to remove.
   *
   * Approvals are rare and the query is one indexed read, so polling is
   * cheaper than being wrong.
   */
  const APPROVAL_POLL_MS = 2_000;
  let lastApprovalSignature = approvalsSignature(dao.pendingApprovals(db));

  const approvalPoll = setInterval(() => {
    // Nobody watching means nothing to tell. The idle shutdown handles the
    // rest.
    if (sseClients.size === 0) return;

    let signature: string;
    try {
      signature = approvalsSignature(dao.pendingApprovals(db));
    } catch {
      // A transient read failure must not kill the poll; the next tick
      // retries. Dying here would look exactly like no approvals arriving.
      return;
    }

    if (signature === lastApprovalSignature) return;
    lastApprovalSignature = signature;

    const frame = `event: approvals\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        /* client hung up mid-write */
      }
    }
  }, APPROVAL_POLL_MS);

  // Never hold the process open for the poll alone.
  approvalPoll.unref();

  const shutdown = (code: number): void => {
    clearInterval(approvalPoll);
    notifyUnsub();
    server.close();
    void notify.close();
    try {
      db.close();
    } catch {
      /* best-effort */
    }
    void unlink(webUrlFile()).catch(() => {
      /* already gone */
    });
    void unlink(webHandshakeFile()).catch(() => {
      /* already gone */
    });
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));
}

/** Exported for tests: they drive `route` through a real http server. */
export interface RouteContext {
  handle: string;
  db: Db;
  /**
   * The secret every `/api/*` request must present.
   *
   * 🛑 MINTED PER PROCESS AND NEVER PERSISTED. Writing it under
   * `stateDir()` would hand it to every containerized agent, because that
   * directory is bind-mounted into each one and a container runs as root.
   */
  token: string;
  /** What a request holding `token` is allowed to reach. */
  capabilities: readonly Capability[];
  sseClients: Set<ServerResponse>;
  /**
   * The loopback port this server bound to. 🛑 EVERY ORIGIN CHECK IS DERIVED
   * FROM THIS, never from the request. A value taken off the request is a
   * value the attacker chose.
   */
  port: number;
}

/** The only hosts a loopback server should ever answer to. */
function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((h) => `http://${h}`);
}

export async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // API routes
  // 🛑 DNS REBINDING FIRST, because it defeats an Origin check on its own.
  // An attacker who points evil.com at 127.0.0.1 makes the browser send
  // Host: evil.com AND Origin: http://evil.com. Compared against each other
  // they MATCH, and the request is genuinely same-origin, so the attacker
  // reads the replies too. Comparing against a FIXED list built from the
  // bound port is what makes that fail.
  if (!allowedHosts(ctx.port).includes(req.headers.host ?? "")) {
    return respondJson(res, { error: "unexpected host" }, 403);
  }

  // 🛑 Then cross-site POSTs. readJsonBody ignores Content-Type, so
  // `text/plain` is a CORS-simple request with no preflight.
  //
  // ⚠️ A CROSS-SITE REQUEST DOES NOT ALWAYS CARRY ORIGIN. A plain GET
  // subresource — <img>, <script>, <link> — sends none. So this check alone
  // cannot protect anything that mutates on a GET, and nothing on a GET path
  // here may mutate. Marking a room read is a POST for exactly that reason.
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins(ctx.port).includes(origin)) {
    return respondJson(res, { error: "cross-origin request refused" }, 403);
  }

  // The browser's first load carries the token in the query. Trade it for an
  // HttpOnly cookie and redirect, so the secret leaves the ADDRESS BAR and
  // every later `/api/*` fetch carries it without page script.
  //
  // ⚠️ THIS DOES NOT PROMISE THE HISTORY IS CLEAN. A 302 leaves no
  // back-button entry, but the originally-typed url can still reach the
  // history store and the omnibox. Untested in a real browser. The token is
  // per-process and session-scoped, so a leaked old one is already dead.
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.searchParams.has(HANDSHAKE_PARAM)
  ) {
    if (!tokenMatches(ctx.token, url.searchParams.get(HANDSHAKE_PARAM))) {
      return respondJson(res, { error: "bad credential" }, 401);
    }

    url.searchParams.delete(HANDSHAKE_PARAM);
    res.statusCode = 302;
    res.setHeader("Set-Cookie", sessionCookie(ctx.token));
    res.setHeader("Location", `${url.pathname}${url.search}`);
    res.end();

    return;
  }

  // 🛑 EVERY `/api/*` ROUTE, READS INCLUDED, AND THE BIND ADDRESS IS NOT PART
  // OF THE DECISION. A container reaches the host's 127.0.0.1 through
  // `host.docker.internal`, which Docker Desktop proxies from the host side,
  // so the Host allowlist above is a second check and never the only one.
  const needed = requiredCapability(req.method ?? "GET", path);

  if (needed !== null) {
    if (
      !tokenMatches(ctx.token, cookieValue(req.headers.cookie, COOKIE_NAME))
    ) {
      return respondJson(
        res,
        { error: "api credential required; reopen the url from the terminal" },
        401,
      );
    }

    if (!ctx.capabilities.includes(needed)) {
      return respondJson(
        res,
        { error: `this credential cannot ${needed}` },
        403,
      );
    }
  }

  if (path === "/api/whoami") return handleWhoami(res, ctx);
  if (
    path === "/api/messages" &&
    req.method === "GET" &&
    url.searchParams.has("around_id")
  )
    return handleMessagesAround(url, res, ctx);
  if (path === "/api/messages" && req.method === "GET")
    return handleGetMessages(url, res, ctx);
  if (path === "/api/messages" && req.method === "POST")
    return handlePostMessage(req, res, ctx);
  if (path === "/api/rooms/join" && req.method === "POST")
    return handleRoomJoin(req, res, ctx);
  if (path === "/api/rooms/leave" && req.method === "POST")
    return handleRoomLeave(req, res, ctx);
  if (path === "/api/rooms/style" && req.method === "POST")
    return handleRoomStyle(req, res, ctx);
  if (path === "/api/kick" && req.method === "POST")
    return handleKick(req, res, ctx);
  if (path === "/api/rooms/delete" && req.method === "POST")
    return handleRoomDelete(req, res, ctx);
  if (path === "/api/rooms/read" && req.method === "POST")
    return handleRoomRead(req, res, ctx);
  if (path === "/api/activity" && req.method === "POST")
    return handleActivity(req, res, ctx);
  if (path === "/api/messages/clear" && req.method === "POST")
    return handleMessagesClear(req, res, ctx);
  if (path === "/api/approvals" && req.method === "GET")
    return handleGetApprovals(res, ctx);
  if (path === "/api/claims" && req.method === "GET")
    return handleGetClaims(res, ctx);
  if (path === "/api/agents/live" && req.method === "GET")
    return handleLiveAgents(res, ctx);
  if (path === "/api/context-gate" && req.method === "POST")
    return handleContextGateSet(req, res, ctx);
  if (path === "/api/agents/stop" && req.method === "POST")
    return handleStopAgents(req, res, ctx);
  if (path === "/api/agents" && req.method === "GET")
    return handleRegistrations(res, ctx);
  if (path === "/api/agents" && req.method === "POST")
    return handleRegisterAgent(req, res);
  if (path === "/api/agents/forget" && req.method === "POST")
    return handleForgetAgent(req, res);
  if (path === "/api/agents/plan" && req.method === "GET")
    return handleAgentPlan(url, res);
  if (path === "/api/agents/confirm" && req.method === "POST")
    return handleConfirmAgentPlan(req, res);
  if (path === "/api/search" && req.method === "GET")
    return handleSearch(url, res, ctx);
  if (path === "/api/approvals/answer" && req.method === "POST")
    return handleAnswerApproval(req, res, ctx);
  if (path === "/api/files" && req.method === "GET")
    return handleFileHints(url, res);
  if (path === "/api/events") return handleSseStream(req, res, ctx);

  // Static assets
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end();
    return;
  }
  await serveStatic(path, res);
}

// ── API handlers ─────────────────────────────────────────────────────────

/**
 * The (vendor, mode) pair each handle is started with — #132.
 *
 * 🛑 NOT `/api/agents/live`, WHICH IS THE SOCKET REGISTER. A handle can be
 * connected without being registered and registered without being connected,
 * so the two surfaces answer different questions and neither substitutes.
 *
 * 🛑 `mode` IS WITHHELD FROM A CALLER WITHOUT `admin`. It says whether that
 * agent runs contained, so the lowest tier would otherwise read a map of which
 * agents have full host access. The route itself stays `read`, because
 * `/api/agents/live` already returns the handle list at that tier.
 *
 * ⚠️ FILTERED HERE AND NOT IN `readRegistrations`. The spawn path reads the
 * same store and needs `mode`.
 *
 * 🛑 THE NON-ADMIN BRANCH LISTS ITS KEYS RATHER THAN SPREADING `config`, SO A
 * FIELD ADDED LATER IS WITHHELD UNTIL SOMEONE NAMES IT. Spreading would read
 * better and would disclose that field on the day it lands. Raised by claude2
 * on PR 369; failing closed is the answer.
 */
function handleRegistrations(res: ServerResponse, ctx: RouteContext): void {
  const config = readRegistrations();
  // #132 slice 4a — what THIS BUILD can spawn, for the card's vendor control.
  //
  // 🛑 SERVED RATHER THAN HARDCODED IN THE BROWSER, and at every tier. The
  // route takes any non-empty vendor string and `spawnFor` is what throws, at
  // start time — so the operator learns their typo one step removed from the
  // form. A copy in `app.js` would keep offering a vendor the day an adapter
  // leaves `REGISTRY`.
  //
  // ⚠️ TOP LEVEL, NOT A ROW FIELD. The hand-listing below is about per-handle
  // config, and this is a property of the build.
  const vendors = vendorsWithSpawn();

  if (ctx.capabilities.includes("admin")) {
    respondJson(res, { ...config, vendors });
    return;
  }

  const agents = Object.fromEntries(
    Object.entries(config.agents).map(([handle, { vendor }]) => [
      handle,
      { vendor },
    ]),
  );

  respondJson(res, { agents, vendors });
}

/**
 * Store one handle's pair, replacing any record it had.
 *
 * 🛑 REPLACE, NEVER MERGE, AND THERE IS DELIBERATELY NO PATCH VERB.
 * `registerAgent`'s docblock gives the reason: both fields are required, so a
 * merge could only carry a stale half — and the stale half is `mode`, which
 * decides whether the agent is contained.
 */
async function handleRegisterAgent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    handle?: unknown;
    vendor?: unknown;
    mode?: unknown;
  };

  if (typeof body.handle !== "string" || body.handle.length === 0) {
    return respondJson(
      res,
      { error: "handle must be a non-empty string" },
      400,
    );
  }

  // 🛑 ONLY A CALLER MISTAKE BECOMES A 4xx. `registerAgent` also writes, and a
  // failed write or a full disk must stay a 500 — the same split
  // `handleSend`'s `RoomSendInputError` catch makes. The store owns the rules;
  // this maps their one error class.
  try {
    const stored = registerAgent(body.handle, {
      vendor: body.vendor,
      mode: body.mode,
    } as AgentRegistration);
    respondJson(res, { handle: body.handle, ...stored });
  } catch (e) {
    if (e instanceof RegistrationInputError) {
      return respondJson(res, { error: e.message }, 400);
    }
    throw e;
  }
}

/**
 * Forget one handle's registration.
 *
 * ⚠️ A HANDLE WITH NO RECORD IS A 200, NOT A 404. `unregisterAgent` writes
 * nothing in that case, including not creating the file, so there is no state
 * for a 404 to describe and a retry must not start failing.
 */
async function handleForgetAgent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as { handle?: unknown };

  if (typeof body.handle !== "string" || body.handle.length === 0) {
    return respondJson(
      res,
      { error: "handle must be a non-empty string" },
      400,
    );
  }

  try {
    unregisterAgent(body.handle);
  } catch (e) {
    if (e instanceof RegistrationInputError) {
      return respondJson(res, { error: e.message }, 400);
    }
    throw e;
  }

  respondJson(res, { handle: body.handle, forgotten: true });
}

/**
 * The container plan for one handle, or why there is none.
 *
 * 🛑 ONE RESOLUTION FOR BOTH ROUTES. The GET shows a plan and the POST
 * approves one, so a second copy of these three refusals would be free to
 * disagree about which handles have a plan at all.
 *
 * 🛑 ONLY A CALLER MISTAKE BECOMES A 4xx, which is why `spawnFor` is called
 * on its own line. `buildConfirmPlan` reads three files, and a failed read has
 * to stay a 500 — the split `handleRegisterAgent` already makes.
 */
interface PlanRefusal {
  readonly error: string;
  readonly status: number;
}

type PlanLookup = { readonly plan: ContainerPlan } | PlanRefusal;

function containerPlanFor(handle: string): PlanLookup {
  const { agents } = readRegistrations();

  // `Object.hasOwn`, so `__proto__` is a missing handle rather than an
  // inherited object with no `mode`.
  if (!Object.hasOwn(agents, handle)) {
    return {
      error: `"${handle}" has no registration, so there is no plan to approve`,
      status: 404,
    };
  }

  const record = agents[handle];

  // 🛑 A HOST HANDLE IS REFUSED, NOT SHOWN A HYPOTHETICAL. The plan describes
  // a container this handle will not start, and an operator who approved one
  // would have recorded a decision about nothing.
  if (record.mode !== "docker") {
    return {
      error:
        `"${handle}" is registered to run on the host rather than contained, ` +
        "so it has no container plan",
      status: 409,
    };
  }

  let spawn;

  try {
    spawn = spawnFor(record.vendor);
  } catch (e) {
    // The only throw inside this try, and it names the vendor the operator
    // typed. That is what makes 409 the right answer.
    return { error: (e as Error).message, status: 409 };
  }

  // 🛑 OUTSIDE THE try, AND THAT IS THE WHOLE POINT. `buildConfirmPlan` reads
  // the override store, and `resolveOverrideFor` THROWS on a malformed
  // `overrides/<handle>.json` or a named profile that is not on disk. Caught
  // above, a file fault on this machine would answer 409 — a refusal ABOUT THE
  // HANDLE — and send the operator to inspect a registration that is fine.
  // Found by claude2 on PR 376.
  return { plan: buildConfirmPlan(spawn, handle) };
}

function isRefusal(lookup: PlanLookup): lookup is PlanRefusal {
  return "error" in lookup;
}

/**
 * The plan one handle must approve, with whether it already has — #132.
 *
 * 🛑 ITS OWN ROUTE, NEVER A FIELD ON `GET /api/agents`. `spawnFor` throws for
 * a vendor this build cannot spawn and the store takes any non-empty vendor
 * string, so folded into the list route one mistyped row would 500 the whole
 * card. `/api/agents` is what the card renders from and it must not be able to
 * fail on one handle.
 */
function handleAgentPlan(url: URL, res: ServerResponse): void {
  const handle = url.searchParams.get("handle") ?? "";

  if (handle.length === 0) {
    return respondJson(
      res,
      { error: "handle must be a non-empty query parameter" },
      400,
    );
  }

  const lookup = containerPlanFor(handle);

  if (isRefusal(lookup)) {
    return respondJson(res, { error: lookup.error }, lookup.status);
  }

  const verdict = confirmVerdict(handle, lookup.plan);
  const changes = verdict.kind === "changed" ? verdict.changes : [];

  respondJson(res, {
    handle,
    // Flattened to the kind, so the browser reads one string. The changes are
    // lifted alongside it rather than nested inside the one verdict that
    // carries them.
    verdict: verdict.kind,
    // 🛑 THE STRUCTURED PLAN IS WHAT THE CONFIRM ECHOES BACK, so it is sent
    // as well as the text. The browser diffs nothing itself; it returns this
    // object unchanged and the server re-derives the comparison.
    plan: lookup.plan,
    // 🛑 FORMATTED HERE, BECAUSE `web/assets/logic.js` CANNOT IMPORT FROM
    // `src/`. `describePlan` owns the rules a reader depends on — one mount
    // per line and quoted, and `no limit` said out loud for an absent cap —
    // and a copy in the browser would be free to drift from the terminal
    // banner. The same reason `rampFor` is computed server-side.
    planText: describePlan(lookup.plan),
    changes,
    changeText: describeChanges(changes),
  });
}

/**
 * Record that an operator approved the plan they were SHOWN.
 *
 * 🛑 THE PLAN IS REQUIRED AND THERE IS DELIBERATELY NO BARE-HANDLE FORM. A
 * POST carrying only a handle would approve a freshly built plan, which is not
 * necessarily the one on screen — and approving an unread plan is the exact
 * substitution this gate exists to prevent. `confirmVerdict` already separates
 * `changed` from `unseen` for the same reason.
 */
async function handleConfirmAgentPlan(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    handle?: unknown;
    plan?: unknown;
  };

  if (typeof body.handle !== "string" || body.handle.length === 0) {
    return respondJson(
      res,
      { error: "handle must be a non-empty string" },
      400,
    );
  }

  if (
    typeof body.plan !== "object" ||
    body.plan === null ||
    Array.isArray(body.plan)
  ) {
    return respondJson(
      res,
      { error: "plan must be the object GET /api/agents/plan returned" },
      400,
    );
  }

  const lookup = containerPlanFor(body.handle);

  if (isRefusal(lookup)) {
    return respondJson(res, { error: lookup.error }, lookup.status);
  }

  // 🛑 THE SHOWN PLAN IS THE `before`, SO A FIELD IT NEVER CARRIED READS AS
  // CHANGED. `diffPlans` takes a Partial for that reason, which also makes a
  // hand-written body fail closed rather than approve seven unread fields.
  const changes = diffPlans(body.plan as Partial<ContainerPlan>, lookup.plan);

  if (changes.length > 0) {
    return respondJson(
      res,
      {
        error:
          `the container plan for "${body.handle}" changed since it was ` +
          "shown, so nothing was approved",
        changes,
        changeText: describeChanges(changes),
      },
      409,
    );
  }

  markConfirmed(body.handle, lookup.plan);

  respondJson(res, { handle: body.handle, confirmed: true });
}

function respondJson(res: ServerResponse, body: unknown, status = 200): void {
  // 🛑 NONE OF THESE ARE CACHEABLE. The plan response carries the mount map,
  // the env var names and the values digest, and a 200 with no freshness
  // header is one a heuristic cache may put on disk. Two routes already set
  // this by hand; setting it here covers the ones that forgot.
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * The ramp ticks a handle's gauge colours against, for the browser.
 *
 * 🛑 COMPUTED HERE BECAUSE `rampFor` IS THE ONE HOME FOR lee's FRACTIONS.
 * `web/assets/logic.js` cannot import from `src/`, so the alternative was a
 * second copy of 0.5/0.75/0.85 in the browser, free to drift from the ones the
 * restart measures against.
 *
 * ⚠️ FLOOR 0, DELIBERATELY, UNLIKE THE SUPERVISOR'S CALL. A floor skips bands
 * a child spawned past, so that its restart warnings do not all fire on turn
 * 0. A colour fires nothing, so skipping a tick would only make the gauge jump
 * a shade for no reason.
 */
function contextRampFor(db: Db, handle: string): number[] {
  return rampFor(resolveContextGate(db, handle)).map((band) => band.at);
}

/** The gate and its layer, flattened onto a peer row. */
function gateFields(
  db: Db,
  handle: string,
): { context_gate: number; context_gate_source: string } {
  const { gate, source } = resolveContextGateWithSource(db, handle);

  return { context_gate: gate, context_gate_source: source };
}

/**
 * Every registration, or an empty set when the file cannot be read (#371).
 *
 * 🛑 A THROW HERE WOULD 500 A PAGE THAT DOES NOT DEPEND ON THIS FILE.
 * `readRegistrations` refuses a malformed document on purpose, and the spawn
 * path wants that refusal. The gauge LABEL is decoration by comparison, so one
 * stray comma must not take the peer list and the Agents panel with it.
 */
function registrationsOrEmpty(): RegistrationConfig {
  try {
    return readRegistrations();
  } catch {
    return { agents: {} };
  }
}

/**
 * Whether this handle's vendor reports a context window at all (#371).
 *
 * `null` means unknown, and `reportsContextFor`'s header says why that is a
 * third answer rather than a `false`.
 *
 * ⚠️ THE PEER LIST IS KEYED BY THE CHILD HANDLE AND `agents.json` BY THE
 * SUPERVISOR'S. `supervisorHandleFor` is the only inverse of that suffix; a
 * lookup on the child handle alone misses every supervised agent, and a lookup
 * on the derived key alone misses a handle whose own name ends in `-agent`.
 *
 * ⚠️ AN OPERATOR WHO REGISTERS THE WRONG VENDOR MISLABELS THE WAIT, and it
 * heals itself. A claude child under a `cursor` registration reads "n/a" until
 * its first reading arrives, after which `reportsContext` is never consulted.
 * Raised by claude1 on #371 and left as a note on purpose.
 *
 * Exported for its own test, as `approvalsSignature` is: the suffix inverse
 * above is the whole mechanism and a payload-shape guard cannot see it.
 */
export function reportsContextOf(
  config: RegistrationConfig,
  handle: string,
): boolean | null {
  const owner = supervisorHandleFor(handle);
  // 🛑 THE DIRECT HIT WINS, AND THE INVERSE IS ONLY A FALLBACK.
  // `supervisorHandleFor`'s own header says its answer is a HINT, not an
  // identity: a handle a human chose ending in `-agent` looks like a child to
  // it. Taking the derived key first made such a registration unreachable —
  // `weird-agent` resolved through `weird`, which nothing registered.
  const stored =
    config.agents[handle] ??
    (owner === null ? undefined : config.agents[owner]);

  return stored === undefined ? null : reportsContextFor(stored.vendor);
}

function handleWhoami(res: ServerResponse, ctx: RouteContext): void {
  const me = dao.getAgent(ctx.db, ctx.handle);
  const peers = dao
    .listAgents(ctx.db, true)
    .filter((a) => a.handle !== ctx.handle);
  const myRooms = dao.myRooms(ctx.db, ctx.handle);
  const allRooms = dao.allRooms(ctx.db);
  const memberRoomNames = new Set(myRooms.map((r) => r.name));
  const discoverRooms = allRooms.filter((r) => !memberRoomNames.has(r.name));
  // #103 — the freshness verdict is computed HERE, not in the browser, so the
  // 15-minute window has one home. A second copy in `web/assets/logic.js`
  // would be free to drift from the one the MCP tools use.
  const now = Date.now();
  // #371 — read ONCE per request. `registrationFor` would re-read the file per
  // peer, and this payload is polled.
  const registrations = registrationsOrEmpty();

  respondJson(res, {
    handle: ctx.handle,
    session_id: me?.session_id,
    // #132 slice 4a — the caller's OWN tier, so a surface can say what it is
    // withholding instead of rendering a control the server will 403.
    //
    // 🛑 DISCLOSES NOTHING, AND NOT BECAUSE EVERY CREDENTIAL IS ADMIN TODAY.
    // A bearer's own grant is not a secret from the bearer: a caller can
    // already enumerate its tier by probing one route per capability and
    // reading 200 against the 403 below. This saves that probe and reveals no
    // grant, which stays true once a narrower credential is minted.
    //
    // ⚠️ NOT "the caller already exercised these to reach here" — `/api/whoami`
    // is `read`-tier, so reaching it exercises `read` alone. Raised by claude2
    // on PR 375.
    //
    // 🛑 `ctx.capabilities`, NEVER `ALL_CAPABILITIES`. That constant is the
    // only credential minted today, so the two are equal in production and a
    // test is the only thing that can tell them apart.
    capabilities: ctx.capabilities,
    peers: peers.map((a) => ({
      ...a,
      ...gaugeFreshness(a.context_reported_at, now),
      // #371 — which of the two blank-gauge causes this peer has, or null when
      // its vendor is unknown. `gaugeDisplay` owns the wording.
      reports_context: reportsContextOf(registrations, a.handle),
      context_ramp: contextRampFor(ctx.db, a.handle),
      // #135 unit 4 — the SET surface needs the number it is editing and the
      // layer it came from. Resolved here for the same reason as the ramp:
      // the three-layer rule has one home and the browser cannot import it.
      ...gateFields(ctx.db, a.handle),
    })),
    rooms: myRooms.map((r) => ({
      ...r,
      unread: dao.roomUnreadCount(ctx.db, r.name, ctx.handle),
    })),
    discoverRooms,
    // #135 slice 4c — the footer that EDITS the global default needs to show
    // it, and no peer row can be relied on to carry it: a peer reports the
    // global only while it has no override of its own.
    context_gate_default: resolveDefaultContextGate(ctx.db),
    version: VERSION,
    // The two roots a dropped file path is shown relative to. The page
    // already lists directories under both through /api/files, so this adds
    // no reach it did not have.
    roots: defaultRoots(),
  });
}

/**
 * A window centred on one message, so a link to an id can be opened (#104).
 *
 * 🛑 THIS MUST NOT BE A SOFTER DOOR THAN `target=` ON THE SAME ROUTE.
 * `handleGetMessages` refuses a room the caller is not a member of, so the
 * same check runs here — and a DM requires the caller to be a party to it.
 * `/api/search` is deliberately unscoped because it serves the operator's own
 * UI — NOT because of the bind address, which authorizes nothing. THIS route
 * already chose the stricter rule, and an id-based lookup that relaxed it would
 * be a bypass, not a precedent.
 *
 * ⚠️ 404 FOR BOTH "no such id" AND "not yours", deliberately. Distinguishing
 * them would turn the endpoint into an oracle for which ids exist in
 * conversations the reader cannot see.
 */
function handleMessagesAround(
  url: URL,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  const parsed = parseAroundId(url.searchParams.get("around_id"));

  if (!parsed.ok) return respondJson(res, { error: parsed.reason }, 400);

  const lim = parseMessageLimit(url.searchParams.get("limit"));

  if (!lim.ok) return respondJson(res, { error: lim.reason }, 400);

  const limit = lim.limit;
  const row = ctx.db
    .prepare("SELECT from_handle, to_handle FROM messages WHERE id = ?")
    .get(parsed.id) as { from_handle: string; to_handle: string } | undefined;

  if (row === undefined)
    return respondJson(res, { error: "no such message" }, 404);

  const target = targetForMessage(row, ctx.handle);
  const isRoom = target.startsWith("#");

  if (isRoom && !dao.isRoomMember(ctx.db, target, ctx.handle)) {
    return respondJson(res, { error: "no such message" }, 404);
  }
  if (!isRoom && !readerIsPartyToDm(row, ctx.handle)) {
    return respondJson(res, { error: "no such message" }, 404);
  }

  const { before, after } = aroundWindow(limit);
  const older = isRoom
    ? recentRoomMessages(ctx.db, target, before + 1, parsed.id + 1)
    : recentDmMessages(ctx.db, ctx.handle, target, before + 1, parsed.id + 1);
  const newer = isRoom
    ? roomMessagesAfter(ctx.db, target, parsed.id, after)
    : dmMessagesAfter(ctx.db, ctx.handle, target, parsed.id, after);

  respondJson(res, {
    target,
    anchor_id: parsed.id,
    messages: [...older, ...newer].map(hydrateForClient),
  });
}

function handleGetMessages(
  url: URL,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  const target = url.searchParams.get("target");
  // 🛑 VALIDATED, NOT CLAMPED. `?limit=abc` used to reach `LIMIT NaN` and 500
  // with the raw SQL message in the body. See `parseMessageLimit`.
  const lim = parseMessageLimit(url.searchParams.get("limit"));

  if (!lim.ok) return respondJson(res, { error: lim.reason }, 400);

  const limit = lim.limit;
  const beforeIdRaw = url.searchParams.get("before_id");
  const beforeId = beforeIdRaw ? parseInt(beforeIdRaw, 10) : undefined;
  if (!target) return respondJson(res, { error: "target required" }, 400);

  let rows: dao.Message[];
  if (target.startsWith("#")) {
    // Room messages: caller must be a member; DAO doesn't have a "recent
    // messages in room" helper so query directly.
    if (!dao.isRoomMember(ctx.db, target, ctx.handle)) {
      return respondJson(res, { error: "not a member of room" }, 403);
    }
    rows = recentRoomMessages(ctx.db, target, limit, beforeId);
  } else {
    // DM between me and target peer.
    rows = recentDmMessages(ctx.db, ctx.handle, target, limit, beforeId);
  }

  respondJson(res, rows.map(hydrateForClient));
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    target?: string;
    body?: string;
    kind?: MessageKind;
  };
  if (!body.target || typeof body.body !== "string") {
    return respondJson(res, { error: "target and body required" }, 400);
  }
  const kind: MessageKind = body.kind ?? "chat";
  const bodyText = body.body;

  if (body.target.startsWith("#")) {
    const room = body.target;
    if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
      return respondJson(res, { error: "not a member of room" }, 403);
    }
    // \u{1F6D1} MAPPED, NOT THROWN. `sendToRoom` enforces the 64 KB cap, and an
    // unwrapped throw reaches the `createServer` catch-all as a 500 \u2014 a
    // client error reported as a server one. `handleRoomJoin` below does the
    // same mapping for an invalid room name.
    let sent;
    try {
      sent = sendToRoom(ctx.db, {
        from: ctx.handle,
        room,
        body: bodyText,
        kind,
        advanceOwnRead: true,
      });
    } catch (e) {
      if (e instanceof NotARoomMemberError) {
        return respondJson(res, { error: "not a member of room" }, 403);
      }
      // 🛑 ONLY caller mistakes become a 4xx. A failed write or a full disk
      // must stay a 500, so anything else is rethrown to the catch-all.
      if (e instanceof RoomSendInputError) {
        return respondJson(res, { error: e.message }, 400);
      }
      throw e;
    }
    respondJson(res, { id: sent.id, sent_at: sent.sent_at });
  } else {
    const peer = body.target;
    if (!dao.getAgent(ctx.db, peer)) {
      return respondJson(res, { error: `unknown peer: ${peer}` }, 404);
    }
    const sent = dao.insertMessage(ctx.db, {
      from: ctx.handle,
      to: peer,
      body: bodyText,
      kind,
    });
    const unread = dao.totalUnreadFor(ctx.db, peer);
    notifyPeer(peer, {
      id: sent.id,
      to: peer,
      from: ctx.handle,
      ts: sent.sent_at,
      body: bodyText,
      kind,
      unread,
    });
    respondJson(res, { id: sent.id, sent_at: sent.sent_at });
  }
}

async function handleRoomJoin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as { room?: string };
  if (!body.room) return respondJson(res, { error: "room required" }, 400);
  try {
    assertRoomName(body.room);
  } catch (e) {
    return respondJson(res, { error: (e as Error).message }, 400);
  }
  const result = dao.joinRoom(ctx.db, body.room, ctx.handle);
  if (result.was_new_member && result.system_message) {
    for (const member of dao.roomMembers(ctx.db, body.room)) {
      if (member === ctx.handle) continue;
      const unread = dao.totalUnreadFor(ctx.db, member);
      notifyPeer(member, {
        id: result.system_message.id,
        to: body.room,
        from: dao.SYSTEM_HANDLE,
        ts: result.system_message.sent_at,
        body: result.system_message.body,
        unread,
      });
    }
  }
  respondJson(res, { ok: true, was_new_member: result.was_new_member });
}

/**
 * #92 — set a room's conversation style from the web selector.
 *
 * A POST because it mutates, like every other room write here. `style: null`
 * clears it.
 */
async function handleRoomStyle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    room?: string;
    style?: string | null;
    custom?: string;
  };

  if (!body.room) return respondJson(res, { error: "room required" }, 400);

  if (!dao.roomExists(ctx.db, body.room)) {
    return respondJson(res, { error: `no such room ${body.room}` }, 404);
  }

  // 🛑 MEMBERSHIP, NOT JUST EXISTENCE. Every other write here is scoped to the
  // caller's own rooms, and a style is an instruction to everyone in one.
  if (!dao.isRoomMember(ctx.db, body.room, ctx.handle)) {
    return respondJson(res, { error: `not a member of ${body.room}` }, 403);
  }

  const style = body.style ?? null;

  if (style !== null) {
    try {
      dao.assertStyleName(style);
      dao.assertStyleCustom(style, body.custom);
    } catch (e) {
      return respondJson(res, { error: (e as Error).message }, 400);
    }
  }

  dao.setRoomStyle(ctx.db, body.room, style, body.custom);

  respondJson(res, { ok: true, style });
}

/**
 * #135 unit 4 — set the restart gate. WEB UI ONLY, per lee 2026-11-18.
 *
 * `handle` absent sets the global default. `handle` present sets that one
 * handle's override, and `gate: null` clears it.
 *
 * 🛑 `gate: null` WITH NO HANDLE IS REFUSED. There is no layer below the
 * built-in, so "clear the global" would either leave the operator on a number
 * they cannot see they are now on, or silently do nothing.
 *
 * 🛑 A LOW GATE IS LEGAL AND GOES SILENT, AND THIS ROUTE DOES NOT REFUSE IT.
 * `assertLegalGate` defines 1..100, and a container child spawns near 14% fill.
 * A gate at or below that fill does NOT loop — `checkContextGate` compares the
 * gate against `childFloor`, logs once and returns for the child's whole life,
 * so NOTHING restarts. Proven by "a gate under the child's spawn fill does NOT
 * restart it, and says why", with its positive control "a gate above the spawn
 * fill still fires on a later reading".
 *
 * Refusing it here would put a second, stricter legality rule one layer above
 * the one the supervisor reads. Warning the operator is the SET surface's job.
 *
 * ⚠️ THE SETTERS THROW ON AN ILLEGAL GATE, so the validation below is not the
 * only guard. It exists to answer 400 rather than 500, and the tests assert the
 * stored value as well as the status.
 */
async function handleContextGateSet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    handle?: string;
    gate?: unknown;
  };
  const gate = body.gate;

  // ⚠️ TYPE-CHECKED, NOT JUST PRESENCE-CHECKED. A non-string handle reached
  // `getAgent` and came back as a raw driver message — "Provided value cannot
  // be bound to SQLite parameter 1", a 500 where every bad GATE gets a clean
  // 400. Found by claude2 on #135 unit 4.
  if ("handle" in body && typeof body.handle !== "string") {
    return respondJson(res, { error: "handle must be a string" }, 400);
  }

  const handle = typeof body.handle === "string" ? body.handle : undefined;

  if (gate === null) {
    if (handle === undefined) {
      return respondJson(
        res,
        {
          error:
            "a handle is required to clear a gate; the global has no layer below it",
        },
        400,
      );
    }
  } else if (!isLegalGate(gate)) {
    // 🛑 THE STORAGE PREDICATE, NOT A SECOND COPY OF ITS CLAUSES. An inline
    // range test here was a duplicate of the rule the setters enforce, free to
    // drift from it. Raised by claude2.
    return respondJson(
      res,
      {
        error:
          "gate must be a whole percentage from 1 to 100, or null to clear an override",
      },
      400,
    );
  }

  // ⚠️ `== null`, NOT `=== undefined`. `dao.getAgent` returns null for an
  // absent handle, so a strict undefined check never fired and an unknown
  // handle was answered 200.
  if (handle !== undefined && dao.getAgent(ctx.db, handle) == null) {
    return respondJson(res, { error: `no such handle ${handle}` }, 404);
  }

  if (handle === undefined) {
    setGlobalContextGate(ctx.db, gate as number);
  } else {
    setHandleContextGate(ctx.db, handle, gate as number | null);
  }

  // ⚠️ NO `effective` ON A GLOBAL SET. It used to resolve against
  // `handle ?? ctx.handle`, so setting the global to 30 while the OPERATOR's
  // own handle was overridden to 90 answered `effective: 90` — correct per the
  // code and misleading per the name. A global set has no single effective
  // number; every peer resolves its own. Found by claude2.
  respondJson(
    res,
    handle === undefined
      ? { ok: true, scope: "global", gate: getGlobalContextGate(ctx.db) }
      : {
          ok: true,
          scope: handle,
          gate,
          effective: resolveContextGate(ctx.db, handle),
        },
  );
}

async function handleRoomLeave(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as { room?: string };
  if (!body.room) return respondJson(res, { error: "room required" }, 400);
  const ok = dao.leaveRoom(ctx.db, body.room, ctx.handle);
  respondJson(res, { ok });
}

/**
 * 🛑 A POST, THOUGH IT READS LIKE A READ. It advances the caller's read
 * watermark, and a mutation on a GET is reachable from an <img> tag on any
 * page, which sends no Origin for the guard to catch.
 *
 * advanceRoomRead takes MAX(), so paging back through history cannot rewind
 * it.
 */
async function handleRoomRead(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    room?: string;
    up_to_id?: number;
  };
  const room = body.room;
  if (!room || typeof body.up_to_id !== "number") {
    return respondJson(res, { error: "room and up_to_id required" }, 400);
  }
  if (!dao.isRoomMember(ctx.db, room, ctx.handle)) {
    return respondJson(res, { error: `you are not a member of ${room}` }, 403);
  }
  dao.advanceRoomRead(ctx.db, room, ctx.handle, body.up_to_id);
  respondJson(res, { ok: true });
}

/**
 * Relay a supervisor's "this agent is working" to every open browser, #240.
 *
 * 🛑 THIS ROUTE MUST NOT TOUCH `sseClients`. `armIdleShutdown` keys on that
 * set's membership alone, so adding to it here would disarm the 60-second idle
 * shutdown and turn `chat-mcp web` into the persistent daemon that was
 * rejected on purpose. A supervisor pulses every 250ms while an agent works,
 * so this route would hold the server up forever.
 *
 * ⚠️ THE FRAME CARRIES THE HANDLE, unlike `event: wake`, which carries a
 * timestamp and makes the client re-fetch. A pulse has nowhere to re-fetch
 * FROM — no endpoint reports who is working — so the payload is the message.
 */
async function handleActivity(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    handle?: unknown;
    phase?: unknown;
  };
  const handle = typeof body.handle === "string" ? body.handle : null;
  const phase = body.phase;

  if (handle === null || handle.length === 0) {
    return respondJson(res, { error: "handle required" }, 400);
  }

  // 🛑 AN ENUMERATED SET, NOT A STRING PASSED THROUGH. A client switching on
  // this value would be switching on whatever a caller sent.
  if (phase !== "tick" && phase !== "end") {
    return respondJson(res, { error: "phase must be 'tick' or 'end'" }, 400);
  }

  const frame = `event: activity\ndata: ${JSON.stringify({ handle, phase, ts: Date.now() })}\n\n`;

  for (const client of ctx.sseClients) {
    try {
      client.write(frame);
    } catch {
      // A hung browser must not turn a pulse into a 500. Every other fan-out
      // in this file does the same, and this one fires far more often.
    }
  }

  respondJson(res, { ok: true });
}

/**
 * dao.deleteRoom states that authorization is the caller's concern. The shim
 * tool checks membership; this is the other caller, so it checks too.
 */
async function handleRoomDelete(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as { room?: string };
  const room = body.room;
  if (!room) return respondJson(res, { error: "room required" }, 400);

  // 🛑 THE RULE IS IN `dao.deleteRoom`, NOT HERE. It was here on the first cut
  // of #89, and four other surfaces kept deleting under the old member-only
  // check. This handler only turns a reason into a status code.
  const result = dao.deleteRoom(ctx.db, room, ctx.handle);

  if (result.ok) return respondJson(res, { ok: true });
  if (result.reason === "not-found")
    return respondJson(res, { error: `${room} does not exist` }, 404);
  if (result.reason === "not-a-member") {
    return respondJson(res, { error: `you are not a member of ${room}` }, 403);
  }

  // Names the owner on purpose: the caller is already a member, so the handle
  // is not news to them, and "ask claude1" is actionable where "refused" is not.
  return respondJson(
    res,
    { error: `only ${result.owner} can delete ${room}` },
    403,
  );
}

/**
 * `/clear` for the web UI, the surface the Ink CLI has had at App.tsx. Rooms
 * are member-only; a DM needs no check because the caller is always one side
 * of the pair it names.
 *
 * 🛑 THE `#` PREFIX DECIDES ROOM-OR-DM, AND `isRoomName` ONLY DECIDES VALID.
 * `app.js` treats every `#`-prefixed target as a room and warns that the
 * delete hits everyone. Discriminating on `isRoomName` alone sent `#Ops` down
 * the DM branch, past the membership check, and answered `cleared: 0` as
 * success under a room-scoped warning.
 */
async function handleMessagesClear(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as { target?: string };
  const target = body.target;
  if (!target) return respondJson(res, { error: "target required" }, 400);

  if (target.startsWith("#")) {
    if (!isRoomName(target)) {
      return respondJson(
        res,
        { error: `${target} is not a valid room name` },
        400,
      );
    }
    if (!dao.isRoomMember(ctx.db, target, ctx.handle)) {
      return respondJson(
        res,
        { error: `you are not a member of ${target}` },
        403,
      );
    }
    return respondJson(res, {
      cleared: dao.deleteRoomMessages(ctx.db, target),
    });
  }

  respondJson(res, {
    cleared: dao.deleteDmMessages(ctx.db, ctx.handle, target),
  });
}

/**
 * The same three refusals the Ink CLI makes at App.tsx, because the web UI
 * reaches one click where /kick has to be typed. The browser confirms first;
 * these are the second line, not the only one.
 */
async function handleKick(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as { handle?: string };
  const target = body.handle;
  if (!target) return respondJson(res, { error: "handle required" }, 400);
  if (target === ctx.handle)
    return respondJson(res, { error: "cannot kick yourself" }, 400);
  if (target === dao.SYSTEM_HANDLE)
    return respondJson(res, { error: "cannot kick system" }, 400);
  if (!dao.deleteAgent(ctx.db, target))
    return respondJson(res, { error: `${target} is not registered` }, 404);
  respondJson(res, { ok: true });
}

/**
 * What a supervised agent is blocked on.
 *
 * 🛑 THE COMMAND GOES OUT VERBATIM. The operator is approving one specific
 * string, and that same string is what the supervisor then allowlists. The UI
 * must be able to show exactly what will run.
 */
/**
 * A fingerprint of the pending set, for change detection.
 *
 * 🛑 IDS, NOT A COUNT. One approval answered and another arriving in the same
 * interval leaves the count identical, and the card would never refresh. That
 * is the whole failure mode a poll exists to avoid.
 */
export function approvalsSignature(
  approvals: readonly { id: number }[],
): string {
  return approvals.map((a) => a.id).join(",");
}

/**
 * Live claims on shared resources (#101).
 *
 * 🛑 THE MINUTES ARE COMPUTED HERE, not in the browser. `logic.js` already
 * holds one copy of a threshold that drifted from the bus (the gauge bands on
 * PR 113), and a second clock is the same shape — a tab left open overnight
 * would render ages against a stale `Date.now()`.
 */
function handleGetClaims(res: ServerResponse, ctx: RouteContext): void {
  const now = Date.now();

  respondJson(res, {
    claims: dao.liveClaims(ctx.db, now).map((c) => ({
      resource: c.resource,
      holder: c.holder,
      note: c.note,
      held_for_minutes: Math.max(1, Math.round((now - c.claimed_at) / 60_000)),
      expires_in_minutes: Math.max(
        1,
        Math.round(Math.max(0, c.expires_at - now) / 60_000),
      ),
    })),
  });
}

/**
 * Every supervisor an operator could stop right now (#40).
 *
 * 🛑 THE SOCKET IS THE REGISTER, NOT THE `agents` TABLE. The table records a
 * pid that nothing keeps fresh, so a row can name a dead process or a reused
 * one. A socket that answers a probe is a supervisor that can be sent a
 * control this instant, which is the only property a Stop button needs.
 *
 * The child is peer-shaped so the page's own `gaugeDisplay()` reads it
 * unchanged, which keeps the 15-minute freshness window in one place.
 */
async function handleLiveAgents(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const { listLiveSupervisors } = await import("../../supervise/socket.js");
  const live = await listLiveSupervisors();
  const now = Date.now();
  const registrations = registrationsOrEmpty();

  respondJson(res, {
    agents: live.map((s) => {
      const child = dao.getAgent(ctx.db, childHandleFor(s.handle));

      return {
        handle: s.handle,
        boundAt: s.boundAt,
        child:
          child === undefined || child === null
            ? null
            : {
                ...child,
                ...gaugeFreshness(child.context_reported_at, now),
                // #371 — the same three-state field the peer rows carry, so
                // one `gaugeDisplay` serves both row shapes.
                reports_context: reportsContextOf(registrations, child.handle),
                context_ramp: contextRampFor(ctx.db, child.handle),
                // #135 slice 4c — the gate control sits on THIS row, so the
                // number it edits and the layer it came from are resolved
                // here. Slice 4a put them on whoami's peers only, which is a
                // different payload from the one the Agents panel renders.
                ...gateFields(ctx.db, child.handle),
              },
      };
    }),
  });
}

/** The two stop modes, so an unknown one is refused rather than defaulted. */
const STOP_MODES = new Set(["graceful", "now"]);

/**
 * Stop one supervisor, or every live one (#40).
 *
 * 🛑 EVERY OUTCOME IS REPORTED BY HANDLE, INCLUDING THE EMPTY SWEEP. A silent
 * `all` gives the operator no way to tell a refused stop from an agent that
 * was never running, which is the whole reason this control exists.
 *
 * 🛑 THE DEFAULT MODE IS PER VENDOR, NOT A CONSTANT (#415). `graceful` by
 * lee's ruling of 2026-10-31, except for a vendor running one process per turn
 * — there an idle agent's graceful stop spawns a turn and bills it, so lee
 * ruled `now` on 2026-11-24. `defaultStopModeFor` owns that answer.
 */
async function handleStopAgents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  let body: unknown;

  try {
    body = await readJsonBody(req);
  } catch {
    return respondJson(res, { error: "body must be json" }, 400);
  }

  const input = (body ?? {}) as {
    handle?: unknown;
    all?: unknown;
    mode?: unknown;
  };
  const all = input.all === true;
  const named = typeof input.handle === "string" ? input.handle.trim() : "";

  // #415 — an omitted mode is resolved from THAT agent's vendor, never from a
  // constant. `defaultStopModeFor`'s header carries the reasoning.
  //
  // 🛑 THE SWEEP KEEPS `graceful`. `all` crosses a fleet whose vendors may
  // differ, so no single per-vendor default is correct for it.
  //
  // ⚠️ `AgentRegistration.mode` IS `docker` OR `host`, NOT A STOP MODE. Only
  // its `vendor` is read here.
  const mode =
    input.mode !== undefined
      ? input.mode
      : all
        ? "graceful"
        : defaultStopModeFor(
            registrationsOrEmpty().agents[named]?.vendor ?? "",
          );

  // 🛑 VALIDATED BEFORE ANYTHING IS SENT. A 400 returned after a graceful stop
  // has already left is a refusal that stopped the agent anyway.
  if (typeof mode !== "string" || !STOP_MODES.has(mode)) {
    return respondJson(res, { error: 'mode must be "graceful" or "now"' }, 400);
  }

  if (!all && named === "") {
    return respondJson(res, { error: "name a handle, or pass all: true" }, 400);
  }

  // 🛑 REFUSED HERE, BECAUSE `socketPathFor` THROWS RATHER THAN RETURNING. The
  // handle becomes a filename, so `assertHandle` is what guards the traversal
  // — but an uncaught throw inside a route leaves the request hanging with no
  // status instead of telling the operator they mistyped a handle. Measured:
  // the test file reported `cancelled 1` on a 15s timeout without this.
  if (!all && !isHandle(named)) {
    return respondJson(res, { error: handleRefusal(named) }, 400);
  }

  const { listLiveSupervisors, requestSupervisorControl } =
    await import("../../supervise/socket.js");
  // ⚠️ A sweep enumerates live sockets; a named stop does NOT, so stopping one
  // agent never depends on every other socket answering a probe first.
  const targets = all
    ? (await listLiveSupervisors()).map((s) => s.handle)
    : [named];

  // 🛑 ONE HOME FOR THE THREE-WAY ACK BRANCH, in `requestSupervisorControl`.
  // The `agents` CLI command interprets the same ack, and the PR #158 fix for
  // the truthy `{ ok: false }` used to exist in both copies.
  const results = await Promise.all(
    targets.map((handle) =>
      requestSupervisorControl(
        handle,
        { kind: "stop", mode: mode as "graceful" | "now" },
        ctx.handle,
      ),
    ),
  );

  respondJson(res, {
    results,
    stopped: results.filter((r) => r.ok).length,
  });
}

/**
 * Search the transcript (#102).
 *
 * 🛑 READ ONLY, AND THAT IS THE POINT. `room_inbox` advances a read watermark,
 * so a search built on it would silently mark messages read — the very cost
 * this endpoint removes. `dao.searchMessages` writes nothing.
 *
 * 🛑 400 ON A BLANK TERM, NOT AN EMPTY LIST. A blank query would match every
 * row, and "here is your whole transcript" is indistinguishable from a search
 * that worked.
 */
function handleSearch(url: URL, res: ServerResponse, ctx: RouteContext): void {
  const limitRaw = url.searchParams.get("limit");
  const parsed = parseSearch({
    q: url.searchParams.get("q") ?? undefined,
    target: url.searchParams.get("target") ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
  });

  if (!parsed.ok) return respondJson(res, { error: parsed.reason }, 400);

  // 🛑 NO `caller`, DELIBERATELY — this surface reads every room and DM.
  // ⚠️ THE BIND ADDRESS IS NOT WHAT MAKES THAT SAFE, WHICH IS WHAT THIS
  // COMMENT USED TO SAY. The api credential in `route` is. The MCP tool
  // passes a caller; see `dao.searchMessages`.
  const { hits, truncated } = dao.searchMessages(ctx.db, {
    pattern: parsed.pattern,
    target: parsed.target,
    limit: parsed.limit,
  });

  respondJson(res, {
    // ⚠️ BOTH NUMBERS. A list of 50 cannot be told from a list truncated at 50.
    returned: hits.length,
    limit: parsed.limit,
    truncated,
    broad: parsed.broad,
    results: hits.map((h) => ({
      id: h.id,
      from: h.from_handle,
      to: h.to_handle,
      sent_at: h.sent_at,
      snippet: snippet(h.body, parsed.q, 220),
    })),
  });
}

function handleGetApprovals(res: ServerResponse, ctx: RouteContext): void {
  respondJson(res, { approvals: dao.pendingApprovals(ctx.db) });
}

/**
 * Record an approve or a deny.
 *
 * 🛑 409 ON AN ALREADY-ANSWERED REQUEST, NOT 200. Two browser tabs are the
 * normal case, and a silent success on the second click would tell the
 * operator they had granted something that was in fact already denied.
 */
async function handleAnswerApproval(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    id?: unknown;
    decision?: unknown;
  };
  const id = typeof body.id === "number" ? body.id : NaN;
  const decision = body.decision;

  if (!Number.isInteger(id))
    return respondJson(res, { error: "id must be an integer" }, 400);
  if (decision !== "approve" && decision !== "deny") {
    return respondJson(
      res,
      { error: "decision must be 'approve' or 'deny'" },
      400,
    );
  }

  const outcome = answerAndNotify(ctx.db, id, decision, ctx.handle);

  // 🛑 404, NOT 409, FOR A MISSING ID. `?.requested == null` is also true for
  // an approval that is not there, and reporting "cannot be approved" for
  // "no such approval" sent one operator looking for the wrong problem.
  if (outcome.kind === "no-such-approval") {
    return respondJson(res, { error: "no such approval" }, 404);
  }

  // 🛑 422, NOT 500. An unnamed request is a valid row that cannot be
  // APPROVED — there is nothing to grant. The UI hides Approve for these,
  // so reaching here means a stale page or a direct call.
  if (outcome.kind === "ungrantable") {
    return respondJson(res, { error: outcome.message, canApprove: false }, 422);
  }

  // 🛑 409 ON AN ALREADY-ANSWERED REQUEST, NOT 200. Two browser tabs are the
  // normal case, and a silent success on the second click would tell the
  // operator they had granted something that was in fact already denied.
  if (outcome.kind === "already-answered") {
    return respondJson(
      res,
      { error: "already answered", decision: outcome.decision },
      409,
    );
  }

  respondJson(res, { ok: true, id, decision });
}

function handleSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // in case anything intermediates
  res.write(`: connected\n\n`);
  ctx.sseClients.add(res);
  // Heartbeat every 20s so proxies + browsers don't drop the connection.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      /* nothing */
    }
  }, 20_000);
  const close = (): void => {
    clearInterval(heartbeat);
    ctx.sseClients.delete(res);
  };
  req.on("close", close);
  req.on("error", close);
}

// ── Static asset serving ─────────────────────────────────────────────────

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const dir = assetsDir();
  // Normalize + guard against path traversal: only serve files whose
  // resolved absolute path lives under `dir`.
  const requestedPath = path === "/" ? "/index.html" : path;
  const clean = normalize(requestedPath).replace(/^([\\/]+)/, "");
  const abs = resolve(dir, clean);
  if (!abs.startsWith(dir + "/") && abs !== dir) {
    res.statusCode = 403;
    res.end();
    return;
  }
  try {
    const s = await stat(abs);
    if (!s.isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const content = await readFile(abs);
    const ext = abs.slice(abs.lastIndexOf("."));
    res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
    res.setHeader("Content-Length", content.length);
    res.setHeader("Cache-Control", "no-cache");
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end();
  }
}

// ── DAO helpers (rows the DAO doesn't expose directly) ───────────────────

function recentRoomMessages(
  db: Db,
  room: string,
  limit: number,
  beforeId?: number,
): dao.Message[] {
  const args: (string | number)[] = [room];
  let where = `to_handle = ?`;
  if (beforeId !== undefined) {
    where += ` AND id < ?`;
    args.push(beforeId);
  }
  args.push(limit);
  const rows = db
    .prepare(
      `SELECT id, from_handle, to_handle, body, sent_at, delivered_at, read_at, kind FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(...args) as unknown as MessageRow[];
  return rows.reverse().map(toMessage);
}

/**
 * The rows immediately AFTER an id, ascending.
 *
 * ⚠️ `recentRoomMessages` walks BACKWARDS from the newest, so it cannot reach
 * forwards from an anchor without fetching the whole tail. These two are the
 * forward half of the window and nothing else uses them yet.
 */
function roomMessagesAfter(
  db: Db,
  room: string,
  afterId: number,
  limit: number,
): dao.Message[] {
  if (limit <= 0) return [];
  const rows = db
    .prepare(
      `SELECT id, from_handle, to_handle, body, sent_at, delivered_at, read_at, kind
       FROM messages WHERE to_handle = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all(room, afterId, limit) as unknown as MessageRow[];

  return rows.map(toMessage);
}

function dmMessagesAfter(
  db: Db,
  me: string,
  peer: string,
  afterId: number,
  limit: number,
): dao.Message[] {
  if (limit <= 0) return [];
  const rows = db
    .prepare(
      `SELECT id, from_handle, to_handle, body, sent_at, delivered_at, read_at, kind
       FROM messages
       WHERE ((from_handle = ? AND to_handle = ?) OR (from_handle = ? AND to_handle = ?))
         AND id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all(me, peer, peer, me, afterId, limit) as unknown as MessageRow[];

  return rows.map(toMessage);
}

function recentDmMessages(
  db: Db,
  me: string,
  peer: string,
  limit: number,
  beforeId?: number,
): dao.Message[] {
  const args: (string | number)[] = [me, peer, peer, me];
  let where = `(from_handle = ? AND to_handle = ?) OR (from_handle = ? AND to_handle = ?)`;
  if (beforeId !== undefined) {
    where = `(${where}) AND id < ?`;
    args.push(beforeId);
  }
  args.push(limit);
  const rows = db
    .prepare(
      `SELECT id, from_handle, to_handle, body, sent_at, delivered_at, read_at, kind FROM messages WHERE ${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(...args) as unknown as MessageRow[];
  return rows.reverse().map(toMessage);
}

interface MessageRow {
  id: number;
  from_handle: string;
  to_handle: string;
  body: string;
  sent_at: number;
  delivered_at: number | null;
  read_at: number | null;
  kind: MessageKind | null;
}

function toMessage(r: MessageRow): dao.Message {
  return {
    id: r.id,
    from_handle: r.from_handle,
    to_handle: r.to_handle,
    body: r.body,
    sent_at: r.sent_at,
    delivered_at: r.delivered_at,
    read_at: r.read_at,
    kind: (r.kind as MessageKind) ?? "chat",
  };
}

/** Attach pre-rendered HTML so the client doesn't need a markdown lib. */
function hydrateForClient(m: dao.Message): dao.Message & { body_html: string } {
  return { ...m, body_html: renderBodyToHtml(m.body) };
}

/**
 * `@`-path hints for the web composer.
 *
 * 🛑 THIS IS A DIRECTORY-LISTING ENDPOINT, so the containment in
 * resolveHintQuery is the whole security of it. A refused token answers with an
 * empty list rather than an error, because telling a caller WHICH paths are
 * refused is itself a probe.
 *
 * Read-only on a GET, which is required: route()'s Origin check cannot see a
 * cross-site <img> or <script>, so nothing on a GET path may mutate. The Host
 * check is what keeps this off evil.com.
 */
async function handleFileHints(url: URL, res: ServerResponse): Promise<void> {
  const query = resolveHintQuery(
    url.searchParams.get("q") ?? "",
    defaultRoots(),
  );
  if (!query) return respondJson(res, { hints: [] });

  // 🛑 The lexical containment in resolveHintQuery is not enough: a symlink
  // inside the root reads as textually inside and readdir follows it. This
  // resolves both sides, and is also where a path that does not exist yet
  // refuses, which is the normal case while typing.
  const dirAbs = await realContainedDir(query);
  if (!dirAbs) return respondJson(res, { hints: [] });

  let dirents: Dirent[];
  try {
    dirents = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return respondJson(res, { hints: [] });
  }

  // 🛑 NARROW BY NAME BEFORE STATTING. The mtime sort needs a stat per entry,
  // and a directory of thousands would otherwise pay for all of them on every
  // keystroke. The prefix filter is the same one buildHints applies.
  const named = dirents.filter((d) => matchesHintPrefix(d.name, query.prefix));
  const entries = await Promise.all(
    named.map(async (d) => {
      const isDirectory = d.isDirectory();
      if (isDirectory) return { name: d.name, isDirectory };

      // A stat can fail on a broken symlink or a file deleted mid-listing.
      // Losing its mtime drops it to the name tiebreak rather than the list.
      try {
        const info = await stat(join(dirAbs, d.name));

        return { name: d.name, isDirectory, mtimeMs: info.mtimeMs };
      } catch {
        return { name: d.name, isDirectory };
      }
    }),
  );

  return respondJson(res, buildHints(entries, query));
}

// ── Browser launcher ─────────────────────────────────────────────────────

/** Try to listen on the user's --port if given, else on the preferred stable
 *  port, else on any OS-assigned free port. Returns the port actually bound. */
async function listenWithFallback(
  server: ReturnType<typeof createServer>,
  explicitPort: number | undefined,
  preferredPort: number,
): Promise<number> {
  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });

  if (explicitPort !== undefined) return tryListen(explicitPort);
  try {
    return await tryListen(preferredPort);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    return tryListen(0);
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best-effort; user can always click the URL we printed.
  }
}
