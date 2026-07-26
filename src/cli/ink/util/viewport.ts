import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Terminal rows reserved for chrome. Header(3) + HintBar(1) + Input(3) = 7
 * baseline, plus alert lane (3) when active and status line (1) when active,
 * plus title(1) + divider(1) inside the messages pane. Budget 14 to keep the
 * header visible even when alerts + status are up.
 */
const CHROME_ROWS = 14;

/** Live terminal row count, re-computes on resize. */
export function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState<number>(stdout?.rows ?? 24);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setRows(stdout.rows);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return rows;
}

/** Live terminal column count, re-computes on resize. */
export function useTerminalColumns(): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState<number>(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setCols(stdout.columns);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  return cols;
}

/**
 * Rows available in the messages pane after subtracting app chrome.
 * ScrollableMessageList uses this as a ROW budget (not message count) —
 * it walks messages backward from the anchor, estimating rendered rows per
 * message, and stops when the budget is spent. Floor at 5 rows so tight
 * terminals still show at least a header + body of one message.
 */
export function useMessageViewport(): number {
  const rows = useTerminalRows();
  return Math.max(5, rows - CHROME_ROWS);
}
