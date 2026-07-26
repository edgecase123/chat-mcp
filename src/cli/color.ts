/**
 * TTY-aware ANSI color wrappers for the terminal REPL.
 *
 * Emits raw text on non-TTY stdout and when `$NO_COLOR` is set (follows
 * https://no-color.org/). Every wrapper is idempotent w.r.t. non-color
 * mode — safe to sprinkle unconditionally through user-facing strings.
 */

// Color precedence: NO_COLOR (off) > FORCE_COLOR (on) > TTY autodetect.
// https://no-color.org/ · https://force-color.org/
const USE_COLOR = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || process.stdout.isTTY === true);

function wrap(code: string): (s: string) => string {
  return (s: string) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const dim = wrap('2');
export const bold = wrap('1');
export const cyan = wrap('36');
export const green = wrap('32');
