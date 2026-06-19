/**
 * `@kampus/read-guard` core — the pure, IO-free decision that absorbs the
 * largest mined subagent error class (~151: `File has not been read yet` 134× +
 * `File has been modified since read` 17×; epic #737, child #740).
 *
 * Before an `Edit`/`Write`, the harness refuses the call when the target was
 * never `Read` this session, or was `Read` but has since changed on disk. This
 * core decides, from (target path, session read-set, current on-disk mtime),
 * whether the edit needs a fresh `Read` first or may proceed unchanged. It is the
 * mechanical guard that replaces a wasted refusal turn with a precise, actionable
 * `Read <path> first` instruction.
 *
 * The non-obvious part is the *staleness* test. A session's read-set is
 * reconstructed from the transcript, which records *when* each `Read` happened but
 * not the file's mtime *at* that moment. So "modified since read" is decided by
 * comparing the file's current mtime against the timestamp of the latest `Read` of
 * that path: if the file changed after we last read it, the recorded view is
 * stale. We use the LATEST read of a path (a re-read refreshes the recorded view),
 * and a strict `>` (mtime exactly equal to the read instant is not stale — the
 * read saw that write). The harness's own check is what we mirror; this core's
 * contract is pinned by `read-guard.unit.test.ts` across the three cases the AC
 * names.
 *
 * Capability note (grounded, not invented): the documented Claude Code PreToolUse
 * hook surface (plugin-dev hook-development; docs.claude.com/.../hooks) can
 * `allow`/`deny`/`ask` and rewrite `updatedInput` — it has **no** documented way to
 * *inject* a new `Read` tool call. So the wiring (`bin.ts`) takes the deterministic
 * **block-with-exact-instruction** form: on `inject-read` it denies the Edit/Write
 * with a `Read <abs-path> first` reason the agent acts on in one turn. The core
 * itself is decision-only and names the case `inject-read` regardless of how the
 * thin layer realizes it.
 */

/** A single recorded `Read` of a path: the epoch-ms instant the harness read it. */
export interface RecordedRead {
	readonly path: string;
	/** Epoch-ms timestamp the `Read` tool_use was recorded in the transcript. */
	readonly readAtMs: number;
}

/** The session read-set: every `Read` this session recorded, in any order. */
export type ReadSet = ReadonlyArray<RecordedRead>;

export type Decision =
	/** Target never read, or read-then-changed-on-disk → a fresh `Read` must precede the edit. */
	| {readonly kind: "inject-read"; readonly path: string; readonly reason: StaleReason}
	/** A current read is on record → the edit proceeds with no extra `Read`. */
	| {readonly kind: "no-op"};

export type StaleReason = "never-read" | "modified-since-read";

const norm = (p: string): string => p.replace(/\\/g, "/");

/**
 * The latest `readAtMs` among reads of `target`, or `null` if `target` was never
 * read. Latest-wins so a re-read of a changed file refreshes the recorded view
 * (and clears a prior staleness).
 */
const latestReadAt = (readSet: ReadSet, target: string): number | null => {
	const t = norm(target);
	let latest: number | null = null;
	for (const r of readSet) {
		if (norm(r.path) !== t) continue;
		if (latest === null || r.readAtMs > latest) latest = r.readAtMs;
	}
	return latest;
};

/**
 * Decide whether an `Edit`/`Write` to `target` needs a `Read` injected first.
 *
 * - **never-read** — `target` is absent from the read-set → `inject-read`.
 * - **modified-since-read** — `target` was read, but its current on-disk mtime is
 *   strictly newer than the latest recorded read → the recorded view is stale →
 *   `inject-read`.
 * - **current-read** — `target` was read and has not changed since → `no-op`.
 *
 * `currentMtimeMs` is the file's current mtime in epoch-ms, or `null` when the
 * target does not exist on disk yet (a `Write` creating a new file): a
 * never-existed file cannot be stale and was never read, so it is a `no-op` — the
 * harness does not require a `Read` before creating a file.
 */
export const decide = (
	target: string,
	readSet: ReadSet,
	currentMtimeMs: number | null,
): Decision => {
	const readAt = latestReadAt(readSet, target);
	if (readAt === null) {
		// A brand-new file (no prior read, nothing on disk) is created, not edited —
		// the harness lets Write create it without a Read, so don't block that.
		if (currentMtimeMs === null) return {kind: "no-op"};
		return {kind: "inject-read", path: target, reason: "never-read"};
	}
	if (currentMtimeMs !== null && currentMtimeMs > readAt) {
		return {kind: "inject-read", path: target, reason: "modified-since-read"};
	}
	return {kind: "no-op"};
};

/** The exact, actionable block instruction for an `inject-read` decision. */
export const blockReason = (path: string, reason: StaleReason): string => {
	const why =
		reason === "never-read"
			? "it has not been read yet this session"
			: "it has changed on disk since you last read it";
	return `Read ${path} first — ${why}. Re-run the Read of that exact path, then retry the edit.`;
};
