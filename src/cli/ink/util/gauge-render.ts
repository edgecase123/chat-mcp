/**
 * Render props for a peer's context gauge. Both the Header (self view),
 * Sidebar (peer list), and WhoPane (table) render from the same helper
 * so bands look consistent everywhere.
 */
export interface GaugeRender {
  /** e.g. "72%" — or "—" when the peer hasn't reported yet. */
  label: string;
  /** Ink color name, or undefined for default. */
  color: string | undefined;
  bold: boolean;
  /** Dim the label — used for the unreported "—" and quiet <70 range. */
  dim: boolean;
  /** True iff the gauge is meaningful (peer has reported at least once). */
  reported: boolean;
}

interface GaugeInput {
  context_used: number | null;
  context_total: number | null;
}

/**
 * Colour bands mirror the state machine in `src/shim/gauge.ts`:
 *   ≥95   red + bold      (critical — /clear NOW)
 *   ≥85   yellow + bold   (recommend hygiene — closest ink has to orange)
 *   ≥70   yellow          (soft — heads up)
 *   <70   green (dim)     (comfortable — deliberately quiet)
 *   null  gray "—"        (peer has never reported)
 * Under 40% we don't dim any further — the terminal already ignores the
 * value; there's no reason to hide green from a fresh session.
 */
export function renderGauge(agent: GaugeInput): GaugeRender {
  const used = agent.context_used;
  const total = agent.context_total;
  if (used == null || total == null || total <= 0) {
    return { label: '—', color: 'gray', bold: false, dim: true, reported: false };
  }
  const pct = Math.round((used / total) * 100);
  const label = `${pct}%`;
  if (pct >= 95) return { label, color: 'red', bold: true, dim: false, reported: true };
  if (pct >= 85) return { label, color: 'yellow', bold: true, dim: false, reported: true };
  if (pct >= 70) return { label, color: 'yellow', bold: false, dim: false, reported: true };
  return { label, color: 'green', bold: false, dim: true, reported: true };
}
