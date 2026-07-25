/**
 * `worktree-sweep` owner-liveness core — decide whether the agent session that OWNS a swept
 * worktree is still running, so the sweep can never remove a live lane's tree (issue #3943).
 *
 * The defect this closes: the sweep's original liveness triple (locked / mtime-idle / open-PR)
 * carries no session-presence signal at all, and a live *shipper* lane is indistinguishable from
 * an orphan under it — clean (a shipper only reads), content-merged (its PR just squashed onto
 * `origin/main`), unlocked (this harness never `git worktree lock`s a provisioned tree), and
 * file-mtime idle (a >30min ship touches nothing in the tree; it only runs `gh api`). Two LIVE
 * shipper worktrees were removed mid-run under exactly that state. ADR 0191 is the rule the sweep
 * was missing: a resource claim's liveness rides its HOLDER's presence, never an age window.
 *
 * The presence chain — both halves grounded in observed on-disk artifacts, not inferred:
 *   1. **owner** — the `sessionId` the `WorktreeCreate` hook stamps into the worktree's own git
 *      admin dir (`<gitdir>/kampus-owner.json`, written by `hooks/create-worktree.sh`). For a
 *      `$TMPDIR`-rooted `review-head-*` tree, which no hook provisions, the fallback is a bare
 *      session-UUID segment in its own path (the harness roots a session's `$TMPDIR` scratchpad
 *      at `…/<session-uuid>/scratchpad/`).
 *   2. **liveness** — the harness's session registry: one `<config>/sessions/<pid>.json` per
 *      RUNNING session, carrying `{pid, sessionId}` and deleted when the session exits.
 *
 * IO-free by design: the caller reads the files and probes the pids, so every rule below is
 * unit-testable without a filesystem or a spawned agent.
 *
 * **The asymmetry is the whole point.** Every unresolvable input collapses to `"unknown"`, which
 * the classifier KEEPS: a leaked orphan is a cleanup problem, a removed live tree is destroyed
 * work. So "cannot prove dead" and "dead" must never collapse into one verdict — a missing stamp,
 * an unreadable registry, or a probe that could not execute is not evidence of death.
 */

/**
 * `"dead"` is the ONLY verdict that lets a removal proceed. `"unknown"` is a distinct third
 * state on purpose — collapsing it into `"dead"` is the over-reaping defect (#3943).
 */
export type OwnerLiveness = "alive" | "dead" | "unknown";

/** A bare session-UUID path segment (the shape both the registry and the sidecar layout use). */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const parseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
};

const objectField = (v: unknown, key: string): unknown =>
	typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;

/**
 * The owning session id read off a worktree's `kampus-owner.json` stamp, or `null` when the file
 * is absent, malformed, or carries no session-UUID-shaped `sessionId`. Requiring the UUID shape
 * (not merely a non-empty string) keeps a truncated or placeholder stamp from resolving to an id
 * that can never match a registry entry — which would read as `"dead"` rather than `"unknown"`.
 */
export const parseOwnerStamp = (raw: string): string | null => {
	const id = asString(objectField(parseJson(raw), "sessionId"));
	return SESSION_UUID.test(id) ? id : null;
};

/** One `<config>/sessions/<pid>.json` entry — a session the harness records as running. */
export interface SessionRegistryEntry {
	readonly pid: number;
	readonly sessionId: string;
}

/** Parse one registry file; `null` unless it yields BOTH a positive pid and a session id. */
export const parseSessionRegistryEntry = (raw: string): SessionRegistryEntry | null => {
	const parsed = parseJson(raw);
	const pid = objectField(parsed, "pid");
	const sessionId = asString(objectField(parsed, "sessionId"));
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	return SESSION_UUID.test(sessionId) ? {pid, sessionId} : null;
};

/**
 * The owning session id recovered from a worktree's own path — the fallback for a `$TMPDIR`-rooted
 * `review-head-*` tree, which no hook provisions and so carries no stamp. Matches only a segment
 * that is a bare session UUID, and returns `null` on **ambiguity** (two different UUID segments)
 * as well as absence: guessing which of two ids owns the tree could name a dead session for a live
 * tree, and the fail-closed `null` (⇒ `"unknown"` ⇒ KEEP) is the only safe answer.
 */
export const sessionIdFromPath = (path: string): string | null => {
	const found = new Set<string>();
	for (const segment of path.replace(/\\/g, "/").split("/")) {
		if (SESSION_UUID.test(segment)) found.add(segment.toLowerCase());
	}
	if (found.size !== 1) return null;
	for (const only of found) return only;
	return null;
};

/**
 * The registry as the boundary observed it. `readable` is false when the registry directory could
 * not be enumerated at all — a missing directory, a permission error, a harness that does not
 * write one. `alive` per entry is the boundary's pid-presence probe, which must fail toward TRUE:
 * a probe that could not execute is not evidence the process is gone. A pid reused by an unrelated
 * process also reads alive, which only ever KEEPS a tree, so no `procStart` identity check is
 * needed here (the registry does carry one).
 */
export interface SessionRegistryProbe {
	readonly readable: boolean;
	readonly entries: ReadonlyArray<{readonly sessionId: string; readonly alive: boolean}>;
}

/**
 * The set of session ids proven alive, or `null` when the registry cannot be trusted to be
 * complete — in which case every owner resolves `"unknown"` and nothing is removed.
 *
 * Two fail-closed conditions, and the second is the load-bearing one: the sweep itself runs from a
 * `SessionStart` hook, i.e. **inside a session that is by definition alive**, so a complete
 * registry always holds at least one live entry. Zero live entries therefore means the registry is
 * absent, stale, or written in a shape this parser does not understand — never "no session is
 * running". Without that self-corroboration a harness that stopped writing the registry would
 * silently mark every worktree on the machine `"dead"`, which is the failure mode this whole module
 * exists to prevent.
 */
export const liveSessionIds = (probe: SessionRegistryProbe): ReadonlySet<string> | null => {
	if (!probe.readable) return null;
	const live = new Set(probe.entries.filter((e) => e.alive).map((e) => e.sessionId.toLowerCase()));
	return live.size === 0 ? null : live;
};

/**
 * Resolve one worktree's owner liveness. `null` for either input is the unprovable case:
 * an unresolvable owner (no stamp, no session segment in the path) or an untrustworthy registry.
 */
export const resolveOwnerLiveness = (args: {
	readonly ownerSessionId: string | null;
	readonly liveSessionIds: ReadonlySet<string> | null;
}): OwnerLiveness => {
	if (args.liveSessionIds === null || args.ownerSessionId === null) return "unknown";
	return args.liveSessionIds.has(args.ownerSessionId.toLowerCase()) ? "alive" : "dead";
};
