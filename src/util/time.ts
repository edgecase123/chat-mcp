/**
 * Format an epoch-ms timestamp as `MM/DD HH:MM:SS` for terminal output.
 * Short-form date prefix (14 chars total) — long enough to disambiguate
 * older messages, short enough not to dominate the message header.
 */
export function stampOf(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd} ${d.toTimeString().slice(0, 8)}`;
}
