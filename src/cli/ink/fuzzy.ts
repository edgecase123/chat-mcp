/**
 * Case-insensitive subsequence match. Every character of `needle` must
 * appear in `haystack` in order (not necessarily contiguously).
 */
export function fuzzyMatch(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let hi = 0;
  for (let ni = 0; ni < n.length; ni++) {
    while (hi < h.length && h[hi] !== n[ni]) hi++;
    if (hi >= h.length) return false;
    hi++;
  }
  return true;
}

/** Return items whose key matches `needle`, preserving input order. */
export function fuzzyFilter<T>(needle: string, items: T[], key: (t: T) => string): T[] {
  return items.filter((t) => fuzzyMatch(needle, key(t)));
}
