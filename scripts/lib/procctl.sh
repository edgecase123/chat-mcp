# Shared process control for the operator scripts in this directory.
#
# Sourced, never executed. Every function is prefixed `pc_` so a caller can
# define its own helpers without collision.
#
# 🛑 CHAT_MCP_HOME IS HONOURED HERE, not hardcoded to ~/.chat-mcp. The CLI
# reads the same variable (`src/util/paths.ts`, `stateDir()`), so a script
# that ignored it would write its pidfile into one state dir and look for a
# supervisor socket in another.

CHAT_MCP_HOME="${CHAT_MCP_HOME:-$HOME/.chat-mcp}"
PC_RUN_DIR="$CHAT_MCP_HOME/run"
PC_LOG_DIR="$CHAT_MCP_HOME/logs"
PC_SOCK_DIR="$CHAT_MCP_HOME/sock"

# Repo root, resolved from this file rather than from $PWD, so the scripts
# work when called by absolute path from anywhere.
PC_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PC_CLI="$PC_REPO_ROOT/dist/index.js"

if [ -t 1 ]; then
  PC_RED=$'\033[31m'; PC_GREEN=$'\033[32m'; PC_YELLOW=$'\033[33m'
  PC_DIM=$'\033[2m';  PC_BOLD=$'\033[1m'; PC_OFF=$'\033[0m'
else
  PC_RED=''; PC_GREEN=''; PC_YELLOW=''; PC_DIM=''; PC_BOLD=''; PC_OFF=''
fi

pc_ok()   { printf '%s✔%s %s\n' "$PC_GREEN" "$PC_OFF" "$*"; }
pc_warn() { printf '%s!%s %s\n' "$PC_YELLOW" "$PC_OFF" "$*"; }
pc_info() { printf '%s  %s%s\n' "$PC_DIM" "$*" "$PC_OFF"; }
pc_err()  { printf '%s✘%s %s\n' "$PC_RED" "$PC_OFF" "$*" >&2; }
pc_die()  { pc_err "$*"; exit 1; }

# 🛑 0700 ON THE DIRS AND 0600 ON THE LOG, NOT THE DEFAULT UMASK. The web
# server's startup banner contains its session api credential, and that banner
# goes straight into the log. AGENTS.md's convention is that a secret-bearing
# file is 0600 (`writePrivateFileSync`); a log that quotes a credential is one.
# The parent state dir is already 0700, so this is defence in depth — but a
# `CHAT_MCP_HOME` pointed somewhere laxer would otherwise publish the token.
# 🛑 VALIDATE BEFORE BUILDING A PATH, NOT AFTER. A handle becomes a filename
# in three places here — the pidfile, the logfile and the supervisor socket —
# and every one of them is constructed before `node` runs, so the TypeScript
# `assertHandle` in src/util/naming.ts is reached too late to protect them.
# `agent start ../../x` would otherwise write outside the state directory.
# This regex is a copy of that one: keep the two identical.
pc_handle_ok() { [[ "${1:-}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; }

pc_assert_handle() {
  if ! pc_handle_ok "${1:-}"; then
    pc_die "invalid handle \"${1:-}\" — handles must match [a-z0-9][a-z0-9_-]{0,63} (lowercase, no # prefix)"
  fi
}

pc_init() {
  mkdir -p "$PC_RUN_DIR" "$PC_LOG_DIR"
  chmod 700 "$PC_RUN_DIR" "$PC_LOG_DIR" 2>/dev/null || true
}

pc_pidfile() { printf '%s/%s.pid\n' "$PC_RUN_DIR" "$1"; }
pc_logfile() { printf '%s/%s.log\n' "$PC_LOG_DIR" "$1"; }

# Build dist/ if it is missing or older than any source file. The CLI cannot
# run from source, and `supervise --container` shells out to `npm run build`
# for the IMAGE only — it does not build the dist it was launched from.
pc_ensure_built() {
  if [ ! -f "$PC_CLI" ]; then
    pc_info 'dist/ is missing — building'
    ( cd "$PC_REPO_ROOT" && npm run build >/dev/null ) || pc_die 'npm run build failed'
    return
  fi
  if [ -n "$(find "$PC_REPO_ROOT/src" -name '*.ts' -newer "$PC_CLI" -print -quit 2>/dev/null)" ]; then
    pc_info 'src/ is newer than dist/ — rebuilding'
    ( cd "$PC_REPO_ROOT" && npm run build >/dev/null ) || pc_die 'npm run build failed'
  fi
}

pc_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# 🛑 A SOCKET FILE IS NOT A LISTENER. A supervisor killed with SIGKILL leaves
# `~/.chat-mcp/sock/<handle>` behind, and ten such files from test runs in
# October read as ten running agents until this was a real connect. The only
# honest check is to open it.
pc_socket_live() {
  [ -e "$1" ] || return 1
  node -e '
    const net = require("node:net");
    const sock = net.createConnection(process.argv[1]);
    const fail = () => { sock.destroy(); process.exit(1); };
    sock.on("connect", () => { sock.destroy(); process.exit(0); });
    sock.on("error", fail);
    setTimeout(fail, 2000);
  ' "$1" 2>/dev/null
}

# Echo a live pid, or nothing. A pidfile naming a dead process is REMOVED and
# reported, never silently treated as "not running" — a stale pidfile and a
# clean first run look identical otherwise.
pc_live_pid() {
  local file; file="$(pc_pidfile "$1")"
  [ -f "$file" ] || return 0
  local pid; pid="$(cat "$file" 2>/dev/null || true)"
  if pc_alive "$pid"; then printf '%s\n' "$pid"; return 0; fi
  pc_warn "clearing a stale pidfile for '$1' (pid $pid is gone)" >&2
  rm -f "$file"
}

# Launch a detached process, truncate its log, and record its pid.
# Usage: pc_spawn <name> <stdin-text-or-empty> <cmd...>
pc_spawn() {
  local name="$1" stdin_text="$2"; shift 2
  local log; log="$(pc_logfile "$name")"
  # Create it private BEFORE anything is written, so the credential never
  # exists in a world-readable file even momentarily.
  ( umask 077; : > "$log" )
  chmod 600 "$log" 2>/dev/null || true
  if [ -n "$stdin_text" ]; then
    printf '%s\n' "$stdin_text" | nohup "$@" >>"$log" 2>&1 &
  else
    nohup "$@" >>"$log" 2>&1 </dev/null &
  fi
  printf '%s\n' "$!" > "$(pc_pidfile "$name")"
  printf '%s\n' "$!"
}

# Poll until a predicate command succeeds. Prints a dot per second so a slow
# image build does not look like a hang.
# Usage: pc_wait_until <seconds> <description> <cmd...>
pc_wait_until() {
  local limit="$1" what="$2"; shift 2
  local i=0
  printf '%s  waiting for %s%s' "$PC_DIM" "$what" "$PC_OFF"
  while [ "$i" -lt "$limit" ]; do
    if "$@"; then printf '\n'; return 0; fi
    printf '.'
    sleep 1
    i=$((i + 1))
  done
  printf '\n'
  return 1
}

# TERM, then KILL after a grace. Used only where no CLI stop path exists.
pc_kill_pid() {
  local pid="$1" grace="${2:-10}" i=0
  kill "$pid" 2>/dev/null || return 0
  while [ "$i" -lt "$grace" ] && pc_alive "$pid"; do sleep 1; i=$((i + 1)); done
  if pc_alive "$pid"; then
    pc_warn "pid $pid ignored SIGTERM after ${grace}s — sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
}

# Print the last N lines of a log, indented, for a failure report.
pc_log_tail() {
  local name="$1" n="${2:-15}" log; log="$(pc_logfile "$name")"
  [ -f "$log" ] || return 0
  printf '%s  --- last %s lines of %s ---%s\n' "$PC_DIM" "$n" "$log" "$PC_OFF"
  tail -n "$n" "$log" | sed 's/^/    /'
}

pc_usage_die() {
  printf '%sUsage:%s %s\n' "$PC_BOLD" "$PC_OFF" "$1" >&2
  exit 2
}
