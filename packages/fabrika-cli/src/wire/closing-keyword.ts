/**
 * GitHub's auto-closing keyword aimed at an issue — `Fixes #N`, `Closes #N`, `Resolved #N`.
 *
 * One shape, two readers: `build pr` counts every occurrence to find the issues a body closes, and
 * the `## Deviations` reader ends its section at a line that is only this link, because a PR body
 * commonly closes on it and it is never a deviation.
 */

const KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)`;

/** Every closing keyword in `text`, capture group 1 the issue number. A fresh global regex per call. */
export const closingKeywords = (): RegExp => new RegExp(String.raw`\b${KEYWORD}\b`, "gi");

const CLOSING_LINE = new RegExp(String.raw`^[ \t]*${KEYWORD}[ \t]*\.?[ \t]*$`, "i");

/** Is `line` nothing but one closing keyword and its issue reference? */
export const isClosingLine = (line: string): boolean => CLOSING_LINE.test(line);
