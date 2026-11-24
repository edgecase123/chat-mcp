/**
 * The CLI, MCP and supervisor command inventories that `/cli-commands` shows.
 *
 * 🛑 NOTHING HERE IS RUNNABLE FROM THE BROWSER. Each row is text to copy into
 * a terminal, or — for an MCP tool — the name an agent passes to its client.
 * `/cli-commands` renders a copy button per row and no run affordance.
 *
 * 🛑 THE NAMES ARE PINNED AGAINST THE REAL SOURCES BY
 * `test/web/command-inventory.test.ts`. A command added to the CLI, a tool
 * registered in the shim, or a verb added to `scripts/agent` reds that test
 * until it appears here. **The descriptions are editorial** — the CLI's own
 * are paragraphs written for `--help`, and they do not fit one row.
 *
 * ⚠️ THIS IS NOT THE WEB'S SLASH COMMANDS. Those live in `COMMANDS` in
 * `app.js` and are shown by `/help` and `/cheat-sheet`. The two inventories
 * are different things, by lee's ruling, and must not be merged.
 */

/** Category key -> heading. The heading carries the prefix a reader types. */
export const INVENTORY_LABELS = {
  cli: "CLI — chat-mcp <command>",
  mcp: "MCP TOOLS — an agent calls these by name",
  supervisor: "SUPERVISOR — ./scripts/agent <verb>",
};

/**
 * Category key -> what a row's copy payload is prefixed with.
 *
 * 🛑 THE MCP PREFIX IS DELIBERATELY EMPTY, AND `commandRows` HONOURS "" RATHER
 * THAN FALLING BACK. A tool is named, not typed, so a prefix would be wrong.
 */
export const INVENTORY_PREFIXES = {
  cli: "chat-mcp ",
  mcp: "",
  supervisor: "./scripts/agent ",
};

export const INVENTORY = [
  // ── chat-mcp, alphabetical. Names pinned to KNOWN_SUBCOMMANDS.
  {
    name: "agents",
    arg: "<action> <handle>",
    desc: "control a running supervisor: restart | stop",
    cat: "cli",
  },
  {
    name: "aliases",
    arg: "",
    desc: "print a source-able bash/zsh alias block",
    cat: "cli",
  },
  {
    name: "auth",
    arg: "<action> [token]",
    desc: "vendor credentials: set-token | set-gh-token | clear-gh-token",
    cat: "cli",
  },
  {
    name: "boot",
    arg: "<room> <handle>",
    desc: "remove a participant from a room",
    cat: "cli",
  },
  {
    name: "cli",
    arg: "",
    desc: "the terminal REPL, joining the bus as a peer",
    cat: "cli",
  },
  {
    name: "delete-room",
    arg: "<room>",
    desc: "delete a room and every message in it",
    cat: "cli",
  },
  {
    name: "inbox",
    arg: "",
    desc: "read unread messages for a handle",
    cat: "cli",
  },
  {
    name: "install",
    arg: "<framework>",
    desc: "install a framework's wake adapter",
    cat: "cli",
  },
  {
    name: "list",
    arg: "",
    desc: "list peers on the bus",
    cat: "cli",
  },
  {
    name: "list-adapters",
    arg: "",
    desc: "the wake adapters available, and their scopes",
    cat: "cli",
  },
  {
    name: "members",
    arg: "<room>",
    desc: "list a room's members, offline ones included",
    cat: "cli",
  },
  {
    name: "mount",
    arg: "<action> [handle] [key] [dir]",
    desc: "extra mounts for a containerized agent: add | list",
    cat: "cli",
  },
  {
    name: "project",
    arg: "<action> [handle] [dir]",
    desc: "the directory an agent works in: set | list | forget",
    cat: "cli",
  },
  {
    name: "report-context",
    arg: "",
    desc: "push a context-window gauge reading for a handle",
    cat: "cli",
  },
  {
    name: "send",
    arg: "<to> [body]",
    desc: "send one message and exit",
    cat: "cli",
  },
  {
    name: "supervise",
    arg: "<handle>",
    desc: "run a supervisor that owns an agent CLI and feeds it messages",
    cat: "cli",
  },
  {
    name: "uninstall",
    arg: "<framework>",
    desc: "remove a framework's wake adapter",
    cat: "cli",
  },
  {
    name: "web",
    arg: "",
    desc: "the browser dashboard, localhost only",
    cat: "cli",
  },

  // ── MCP tools. An agent names a tool, so no row carries an argument.
  {
    name: "claim",
    arg: "",
    desc: "claim a shared resource",
    cat: "mcp",
  },
  {
    name: "claims",
    arg: "",
    desc: "list live claims",
    cat: "mcp",
  },
  {
    name: "health",
    arg: "",
    desc: "is the bus writing, and to the right file?",
    cat: "mcp",
  },
  {
    name: "inbox",
    arg: "",
    desc: "read pending direct messages",
    cat: "mcp",
  },
  {
    name: "list_agents",
    arg: "",
    desc: "list peers on the bus",
    cat: "mcp",
  },
  {
    name: "list_commands",
    arg: "",
    desc: "which of this project's commands can I run?",
    cat: "mcp",
  },
  {
    name: "register",
    arg: "",
    desc: "update your profile on the bus",
    cat: "mcp",
  },
  {
    name: "release",
    arg: "",
    desc: "release a claim",
    cat: "mcp",
  },
  {
    name: "report_context",
    arg: "",
    desc: "report your context-window usage",
    cat: "mcp",
  },
  {
    name: "room_boot",
    arg: "",
    desc: "boot a participant from a room",
    cat: "mcp",
  },
  {
    name: "room_delete",
    arg: "",
    desc: "delete a room",
    cat: "mcp",
  },
  {
    name: "room_inbox",
    arg: "",
    desc: "read unread room messages",
    cat: "mcp",
  },
  {
    name: "room_join",
    arg: "",
    desc: "join a room",
    cat: "mcp",
  },
  {
    name: "room_leave",
    arg: "",
    desc: "leave a room",
    cat: "mcp",
  },
  {
    name: "room_list",
    arg: "",
    desc: "list rooms",
    cat: "mcp",
  },
  {
    name: "room_members",
    arg: "",
    desc: "list a room's members",
    cat: "mcp",
  },
  {
    name: "room_send",
    arg: "",
    desc: "post a message to a room",
    cat: "mcp",
  },
  {
    name: "run_command",
    arg: "",
    desc: "run one of this project's commands",
    cat: "mcp",
  },
  {
    name: "search",
    arg: "",
    desc: "search the transcript",
    cat: "mcp",
  },
  {
    name: "send",
    arg: "",
    desc: "send a 1:1 message to a peer",
    cat: "mcp",
  },
  {
    name: "set_status",
    arg: "",
    desc: "set your live status and focus",
    cat: "mcp",
  },
  {
    name: "set_style",
    arg: "",
    desc: "set a room's conversation style",
    cat: "mcp",
  },
  {
    name: "wait_for_message",
    arg: "",
    desc: "block until a message arrives",
    cat: "mcp",
  },
  {
    name: "whoami",
    arg: "",
    desc: "who am I on the bus?",
    cat: "mcp",
  },

  // ── scripts/agent. Four verbs, pinned to its dispatch arms.
  {
    name: "restart",
    arg: "<handle>",
    desc: "reload in place, or a cold start if nothing is listening",
    cat: "supervisor",
  },
  {
    name: "start",
    arg: "<handle> [dir]",
    desc: "start a containerized agent and wait for its supervisor",
    cat: "supervisor",
  },
  {
    name: "status",
    arg: "[handle]",
    desc: "one handle, or every running agent when omitted",
    cat: "supervisor",
  },
  {
    name: "stop",
    arg: "<handle> [--now]",
    desc: "graceful stop; --now skips the notice wait",
    cat: "supervisor",
  },
];
