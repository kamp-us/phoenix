/**
 * The harness's live-session registry, as this package reads it: where the files live, what a
 * session id looks like, and what one entry means.
 *
 * It sits at the `src/` root rather than under either consumer because it is owned by neither.
 * `worktree-sweep` / `worktree-reap` read the registry to decide whether a worktree's owner is
 * still running; `review-head materialize` reads the same registry to stamp a tree's lock with its
 * owning session's pid. One rule, two callers on opposite sides of the §CP boundary — a copy per
 * side would be two liveness rules free to drift (ADR 0218; ruling on #4149).
 *
 * IO-free: the location rule takes its joiner as an argument and the parser takes text, so each
 * caller keeps its own path/filesystem seam (the Effect `Path` service in the sweep, `node:path` in
 * `materialize`).
 */

/** A bare session-UUID (the shape both the registry and the worktree sidecar layout use). */
export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The registry directory — one `<pid>.json` per RUNNING session, deleted when the session exits.
 * `$CLAUDE_CONFIG_DIR` is the harness's own override for the config root; absent it, the tool's
 * default config home under the user's home dir.
 */
export const sessionRegistryDir = (args: {
	readonly configDir: string | undefined;
	readonly home: string;
	readonly join: (...segments: Array<string>) => string;
}): string => args.join(args.configDir?.trim() || args.join(args.home, ".claude"), "sessions");

/** One `<config>/sessions/<pid>.json` entry — a session the harness records as running. */
export interface SessionRegistryEntry {
	readonly pid: number;
	readonly sessionId: string;
}

/**
 * Parse one registry file; `null` unless it yields BOTH a positive integer pid and a session id of
 * the expected UUID shape. Requiring the shape (not merely a non-empty string) keeps a truncated or
 * placeholder id from resolving to something that can never match a real session — which downstream
 * would read as a dead owner rather than an unresolvable one.
 */
export const parseSessionRegistryEntry = (raw: string): SessionRegistryEntry | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const {pid, sessionId} = parsed as {readonly pid?: unknown; readonly sessionId?: unknown};
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof sessionId !== "string") return null;
	const id = sessionId.trim();
	return SESSION_UUID.test(id) ? {pid, sessionId: id} : null;
};
