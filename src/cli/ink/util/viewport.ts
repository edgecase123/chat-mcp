import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/** Terminal rows reserved for chrome (header, alert lane, hint bar, input). */
const CHROME_ROWS = 10;
/** Rows per rendered message (header line + body line). No margin. */
const ROWS_PER_MESSAGE = 2;

/**
 * Return the approximate number of full messages that fit in the current
 * terminal below the app chrome. Re-computes on terminal resize.
 * Minimum 5 so tiny terminals still show *something*.
 */
export function useMessageViewport(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState<number>(stdout?.rows ?? 24);
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setRows(stdout.rows);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  const usable = Math.max(0, rows - CHROME_ROWS);
  return Math.max(5, Math.floor(usable / ROWS_PER_MESSAGE));
}
