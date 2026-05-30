/**
 * Tiny text utilities shared by feature services.
 *
 * Kept dependency-free and Effect-free — these are pure functions called from
 * inside `Effect.fn` bodies, not effects themselves. Adding more here is fine;
 * adding services or IO is not.
 */

/**
 * Default excerpt length. Each feature picks the cap that matches its
 * legacy DO contract:
 * - Sözlük definitions: 140 chars (terse, fits a card)
 * - Pano posts/comments: 280 chars (tweet-sized, fits a feed item)
 *
 * The function accepts an explicit `max` to make those call sites self-
 * documenting.
 */
const DEFAULT_EXCERPT_LEN = 280;

/**
 * Collapse whitespace and truncate to `max` characters, appending an ellipsis
 * when the source was cut. Idempotent: feeding the result back in returns the
 * same value.
 *
 * Behavior matches the inline `excerpt()` previously duplicated in
 * `features/sozluk/module.ts` (max 140) and `features/pano/module.ts` (max 280).
 *
 * @example
 *   excerpt("  hello   world  ")          // "hello world"
 *   excerpt("a".repeat(300), 140)          // 140-char string ending in "…"
 */
export function excerpt(body: string, max: number = DEFAULT_EXCERPT_LEN): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1).trimEnd()}…`;
}
