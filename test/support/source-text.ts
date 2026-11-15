/**
 * Reading source TEXT as a guard, now that prettier owns the formatting.
 *
 * A guard here asserts the shape of a statement — a refusal comes first, a
 * verb is registered, an attribute is set. Line breaks are not part of any of
 * those claims, and prettier moves them.
 *
 * 🛑 QUOTE STYLE IS NOT NORMALISED HERE, and one attempt to do so broke four
 * guards. `data-handle="${CSS.escape(handle)}"` inside a template literal and
 * `placeholder="…"` in HTML both need their double quotes, and prettier leaves
 * both alone. A guard that reads a JS string delimiter writes `['"]` instead.
 */

/**
 * Collapse every run of whitespace to one space, so a statement prettier
 * wrapped over four lines still reads as the one statement it is.
 *
 * 🛑 Order by STRING INDEX after this, never by line index. A reflow moves
 * line numbers; an index comparison survives it.
 */
export function oneLine(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}
