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

# Default handle for the \`chat\` function. Override before sourcing:
#   export CHAT_MCP_HANDLE="lee"
: "\${CHAT_MCP_HANDLE:=\${USER:-user}}"

# Optional local-checkout override. When set, wrappers invoke this instead of
# npx. Word-split on spaces, so avoid paths with spaces. Example:
#   export CHAT_MCP_BIN="node /path/to/chat-mcp/dist/index.js"
_chat_mcp_bin() {
  if [ -n "\$CHAT_MCP_BIN" ]; then
    # Intentional word split on CHAT_MCP_BIN.
    \$CHAT_MCP_BIN "\$@"
  else
    npx -y github:edgecase123/chat-mcp "\$@"
  fi
}

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

# Admin
chat-install()   { _chat_mcp_bin install "\$@"; }
chat-uninstall() { _chat_mcp_bin uninstall "\$@"; }
chat-adapters()  { _chat_mcp_bin list-adapters "\$@"; }
`;
