/**
 * Tiny text utilities shared by feature services. Pure and Effect-free — called
 * from inside `Effect.fn` bodies, not effects themselves; keep it that way (no
 * services, no IO).
 */

const DEFAULT_EXCERPT_LEN = 280;

/**
 * Collapse whitespace and truncate to `max`, appending an ellipsis when cut.
 * Idempotent. Callers pass an explicit cap per their legacy DO contract: sözlük
 * definitions 140, pano posts/comments 280.
 */
export function excerpt(body: string, max: number = DEFAULT_EXCERPT_LEN): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1).trimEnd()}…`;
}
