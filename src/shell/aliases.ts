/**
 * Source-able shell integration for bash/zsh.
 *
 * Emitted verbatim by the `chat-mcp aliases` subcommand. Kept as a single
 * string constant so it ships with the built package without needing a
 * separate asset in `dist/`.
 */
export const SHELL_ALIASES: string = `# chat-mcp shell integration — regenerate with: chat-mcp aliases
#
# Paste this block into ~/.zshrc or ~/.bashrc, or save it and source:
#   mkdir -p ~/.chat-mcp && chat-mcp aliases > ~/.chat-mcp/aliases.sh
#   echo 'source ~/.chat-mcp/aliases.sh' >> ~/.zshrc   # or ~/.bashrc

# Your handle on the bus. Defaults to \$USER; override in your rc:
#   export CHAT_MCP_HANDLE="lee"
: "\${CHAT_MCP_HANDLE:=\${USER:-user}}"
export CHAT_MCP_HANDLE

# Optional local-checkout override. When set, wrappers invoke this instead of
# npx. Word-split on spaces (zsh does not split unquoted expansions, so eval),
# so avoid paths with spaces. Example:
#   export CHAT_MCP_BIN="node /path/to/chat-mcp/dist/index.js"
_chat_mcp_bin() {
  if [ -n "\$CHAT_MCP_BIN" ]; then
    eval "\$CHAT_MCP_BIN \\"\\\$@\\""
  else
    npx -y github:edgecase123/chat-mcp "\$@"
  fi
}

# ────────────────────────────────────────────────────────────────────────
# Interactive REPL
# ────────────────────────────────────────────────────────────────────────

# Join the chat bus as a peer (terminal REPL).
#   chat                 → uses \$CHAT_MCP_HANDLE
#   chat lee             → uses "lee"
#   chat -- --help       → pass flags through (use -- to disambiguate)
chat() {
  local handle="\$CHAT_MCP_HANDLE"
  if [ "\$#" -gt 0 ] && [ "\$1" = "--" ]; then
    shift
  elif [ "\$#" -gt 0 ] && [ "\${1#-}" = "\$1" ]; then
    handle="\$1"
    shift
  fi
  _chat_mcp_bin cli --handle "\$handle" "\$@"
}

# ────────────────────────────────────────────────────────────────────────
# One-shot messaging (sender is \$CHAT_MCP_HANDLE)
# ────────────────────────────────────────────────────────────────────────

# Send a message.
#   chat-send lee "hi there"
#   git log --oneline -5 | chat-send lee -
chat-send() {
  if [ "\$#" -lt 2 ]; then
    echo "usage: chat-send <handle> <body>          # quote a multi-word body" >&2
    echo "       … | chat-send <handle> -           # read body from stdin"    >&2
    return 2
  fi
  local to="\$1" body="\$2"
  if [ "\$body" = "-" ]; then
    _chat_mcp_bin send "\$to" --from "\$CHAT_MCP_HANDLE" --stdin
  else
    # -- protects bodies that start with a dash from being parsed as flags.
    _chat_mcp_bin send "\$to" --from "\$CHAT_MCP_HANDLE" -- "\$body"
  fi
}

# Read unread messages for \$CHAT_MCP_HANDLE (marks them read).
chat-inbox() { _chat_mcp_bin inbox --handle "\$CHAT_MCP_HANDLE" "\$@"; }

# Peek at unread without marking read.
chat-peek()  { _chat_mcp_bin inbox --handle "\$CHAT_MCP_HANDLE" --peek "\$@"; }

# List peers. Default: online only. \`chat-list --all\` to include offline.
chat-list()  { _chat_mcp_bin list "\$@"; }

# List members of a room (includes offline members).
#   chat-members '#leagues'
chat-members() {
  if [ "\$#" -lt 1 ]; then
    echo "usage: chat-members '#room'" >&2
    return 2
  fi
  _chat_mcp_bin members "\$@"
}

# Print own handle (quick sanity check).
chat-me()    { printf '%s\\n' "\$CHAT_MCP_HANDLE"; }

# ────────────────────────────────────────────────────────────────────────
# Admin
# ────────────────────────────────────────────────────────────────────────

chat-install()   { _chat_mcp_bin install   "\$@"; }
chat-uninstall() { _chat_mcp_bin uninstall "\$@"; }
chat-adapters()  { _chat_mcp_bin list-adapters "\$@"; }
`;
