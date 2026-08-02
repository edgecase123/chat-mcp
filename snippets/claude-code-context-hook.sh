#!/usr/bin/env bash
#
# chat-mcp — Claude Code PreToolUse hook that reports estimated context
# usage to the bus. Fires on every tool call. Warnings at 70/85/95% are
# emitted by the report-context CLI to the peer and to any rooms they
# have joined.
#
# ─── Install ─────────────────────────────────────────────────────────
# 1. Copy this file to ~/.chat-mcp/adapters/claude-code-context-<handle>.sh
# 2. chmod +x on it.
# 3. Edit the CHATMCP_HANDLE and CHATMCP_TOTAL below.
# 4. Add a PreToolUse hook in your Claude Code settings.json:
#
#      "hooks": {
#        "PreToolUse": [
#          {
#            "hooks": [
#              {
#                "type": "command",
#                "command": "/absolute/path/to/this-script.sh",
#                "statusMessage": "chat-mcp context gauge (<handle>)"
#              }
#            ]
#          }
#        ]
#      }
#
# The hook script is intentionally non-blocking (backgrounds the CLI call)
# so it can't slow tool invocations. If the report fails, it's silent —
# a broken hook should not break the session.
#
# A future `chat-mcp install claude-code-context --handle X --total N`
# command will automate all of this. For now, wire it up by hand.
#
# ─────────────────────────────────────────────────────────────────────

# EDIT THESE ────────────────────────────────────────────────────────
CHATMCP_HANDLE="claude2"        # your bus handle
CHATMCP_TOTAL="1000000"         # your model's context window (Opus 1M / Sonnet 200k / …)

# The chat-mcp binary. If installed globally: just "chat-mcp".
# If installed via npx cache: an absolute path to the extracted dist/index.js.
CHATMCP_BIN="chat-mcp"
# ────────────────────────────────────────────────────────────────────

# Read Claude Code's PreToolUse JSON payload from stdin. We only need
# transcript_path — the JSONL file whose byte size we use as a token
# proxy.
INPUT="$(cat)"

TRANSCRIPT="$(printf '%s' "$INPUT" | node -e "
try {
  let s = '';
  process.stdin.on('data', d => s += d);
  process.stdin.on('end', () => {
    try {
      const j = JSON.parse(s);
      process.stdout.write(j.transcript_path || '');
    } catch { process.stdout.write(''); }
  });
" 2>/dev/null)"

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

# Byte size → token estimate. ~3.5 chars/token for mixed English + code.
# The absolute number matters less than the trend; percentages compare fine
# across peers even when the tokenizer differs.
BYTES="$(wc -c < "$TRANSCRIPT" | tr -d ' ')"
USED="$(( BYTES * 10 / 35 ))"

# Cap USED at TOTAL so the CLI's validation doesn't reject a jumbo transcript.
if [ "$USED" -gt "$CHATMCP_TOTAL" ]; then
  USED="$CHATMCP_TOTAL"
fi

# Fire and forget — a broken bus should not break tool calls.
"$CHATMCP_BIN" report-context \
  --handle "$CHATMCP_HANDLE" \
  --used "$USED" \
  --total "$CHATMCP_TOTAL" \
  > /dev/null 2>&1 &

exit 0
