import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Terminal rows reserved for chrome. Header(3) + HintBar(1) + Input(3) = 7
 * baseline, plus alert lane (3) when active and status line (1) when active,
 * plus title(1) + divider(1) inside the messages pane. Budget 14 to keep the
 * header visible even when alerts + status are up and one body line wraps.
 */
const CHROME_ROWS = 14;

/**
 * Rows per rendered message. Header line + body line = 2 minimum, but bodies
 * frequently wrap once in a narrow main pane, so budget 3.
 */
const ROWS_PER_MESSAGE = 3;

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

/**
 * Return the approximate number of full messages that fit in the current
 * terminal below the app chrome. Re-computes on terminal resize.
 * Floor at 3 messages so tight terminals still show recent context.
 */
export function useMessageViewport(): number {
  const rows = useTerminalRows();
  const usable = Math.max(0, rows - CHROME_ROWS);
  return Math.max(3, Math.floor(usable / ROWS_PER_MESSAGE));
}
