/**
 * `worktree-sweep` owner-liveness core — decide whether the agent session that OWNS a swept
 * worktree is still running, so the sweep can never remove a live lane's tree (issue #3943).
 *
 * The defect this closes: the sweep's original liveness triple (locked / mtime-idle / open-PR)
 * carries no session-presence signal, and a live *shipper* lane is indistinguishable from an orphan
 * under the age-based half of it — clean (a shipper only reads), content-merged (its PR just squashed
 * onto `origin/main`), and file-mtime idle (a >30min ship touches nothing in the tree; it only runs
 * `gh api`). Two LIVE shipper worktrees were removed mid-run.
 *
 * `locked` is the exception worth stating precisely, because the fix's justification does NOT rest
 * on it being absent: the harness DOES `git worktree lock` each agent worktree it provisions, with a
 * pid-bearing reason (`claude agent <id> (pid <N> start <date>)`) that `worktree-reap` already parses
 * as a presence signal. So the lock gate is real and does protect some live lanes. What it is not is
 * *reliable*: coverage is partial (most registered trees carry no lock at a given moment, and a lock
 * can outlive its session). The `$TMPDIR`-rooted `review-head-*` class was not locked at all when
 * this gate was written, leaving the `review-head-idle` removal path with no lock protection for a
 * live reviewer's tree; `review-head materialize` now locks its tree with the owning session's pid
 * (#4004), which adds a fence but does not make this gate redundant — the lock is one owner signal,
 * this module is the other, and both fail toward KEEP. The root cause of the two observed agent-tree
 * removals is NOT established; this gate is justified as the missing *presence* signal, not as a
 * replacement for a defeated lock.
 *
 * ADR 0191 is the rule the sweep was missing: a resource claim's liveness rides its HOLDER's
 * presence, never an age window.
 *
 * The presence chain — both halves grounded in observed on-disk artifacts, not inferred:
 *   1. **owner** — the `sessionId` the `WorktreeCreate` hook stamps into the worktree's own git
 *      admin dir (`<gitdir>/kampus-owner.json`, written by `hooks/create-worktree.sh`). For a
 *      `$TMPDIR`-rooted `review-head-*` tree, which no hook provisions, the fallback is a bare
 *      session-UUID segment in its own path (the harness roots a session's `$TMPDIR` scratchpad
 *      at `…/<session-uuid>/scratchpad/`).
 *
 *      **This source has NO live producer today (#4180) — read every claim about it as a code
 *      contract, not a runtime fact.** The harness is not invoking the `WorktreeCreate` hook on
 *      the path that provisions agent worktrees, so the stamp is never written: 272 registered
 *      worktrees, 0 stamped. Everything below is correct about what the rules *do* with a stamp;
 *      what they never do in practice is see one. The direction of that gap is safe — an
 *      unstamped tree resolves `"unknown"`, which the classifier KEEPs, so a stamp-less runtime
 *      can only leak orphans, never remove a live tree — but it means the sweep is a one-signal
 *      (lock-derived) design in the field, and `0 reapable` is partly an absence of evidence
 *      rather than a considered spare. Do not build a decision on stamp coverage until #4180
 *      lands a producer that actually fires.
 *   2. **liveness** — the harness's session registry: one `<config>/sessions/<pid>.json` per
 *      RUNNING session, carrying `{pid, sessionId}` and deleted when the session exits. Where those
 *      files live and how one is read is `../../session-registry.ts` — shared with the lock-writer
 *      on the other side of the §CP boundary, owned by neither (ADR 0218).
 *
 * **The owner is the LAUNCHER, never the occupant (#4001).** Both owner sources above resolve the
 * session that *spawned* the tree, not the ephemeral subagent that *occupies* it: the hook runs in
 * the spawning session before the subagent exists, and the `$TMPDIR` scratchpad root is that same
 * spawning session's. A subagent has no registry entry of its own — it runs inside its pane's
 * process — so an occupant-keyed session id is not resolvable on this platform at all. That makes
 * launcher liveness a strict **upper bound**, sound in one direction only:
 *
 *   - launcher DEAD ⇒ the occupant it spawned is necessarily gone too ⇒ `"dead"`.
 *   - launcher ALIVE ⇒ says **nothing** about the occupant. A launcher pane runs for hours and spawns
 *     many short-lived subagent trees, so reading this as `"alive"` KEPT every tree such a pane
 *     ever created for the pane's whole lifetime — the sweep went near-silent during exactly the
 *     runs that generate orphans (#4001). That case is `"launcher-alive"`, a distinct verdict.
 *
 * Occupancy itself is carried by a separate, real signal the classifier checks *above* this one:
 * the harness's own `git worktree lock`, held for the occupying agent's lifetime and released when
 * it finishes. So a tree that reaches this gate is already unlocked, i.e. the harness has released
 * its occupancy — which is why `"launcher-alive"` may fall through to the age/merge gates instead
 * of KEEPing forever. See `classifyWorktree` for the grace window that bounds the residual risk.
 *
 * IO-free by design: the caller reads the files and probes the pids, so every rule below is
 * unit-testable without a filesystem or a spawned agent.
 *
 * **The asymmetry is the whole point.** Every unresolvable input collapses to `"unknown"`, which
 * the classifier KEEPS: a leaked orphan is a cleanup problem, a removed live tree is destroyed
 * work. So "cannot prove dead" and "dead" must never collapse into one verdict — a missing stamp,
 * an unreadable registry, or a probe that could not execute is not evidence of death.
 */
import {SESSION_UUID} from "../../session-registry.ts";

/**
 * `"dead"` is the only verdict that lets a removal proceed outright. `"unknown"` is a distinct
 * state on purpose — collapsing it into `"dead"` is the over-reaping defect (#3943).
 * `"launcher-alive"` is the fourth: a live owner whose liveness proves nothing about the occupant,
 * so it neither removes (it is not `"dead"`) nor KEEPs forever (#4001).
 */
export type OwnerLiveness = "alive" | "launcher-alive" | "dead" | "unknown";

/**
 * Whose identity the owner record carries — the axis the #4001 defect turned on. Every owner
 * resolvable today is a `"launcher"`: NO producer writes an `"occupant"` stamp, deliberately, since
 * a subagent has no session identity of its own to stamp and choosing an occupant-keyed mechanism
 * is an open design call (#3892). The variant exists so that when one arrives it must SAY it names
 * the occupant to be granted occupant authority, instead of inheriting the launcher's over-broad
 * authority by silence — which is exactly how the launcher stamp came to mean presence.
 */
export type OwnerKind = "launcher" | "occupant";

/** A resolved worktree owner: whose session id it is, and what that identity actually names. */
export interface OwnerStamp {
	readonly sessionId: string;
	readonly kind: OwnerKind;
}

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
 * The owner read off a worktree's `kampus-owner.json` stamp, or `null` when the file is absent,
 * malformed, or carries no session-UUID-shaped `sessionId`. Requiring the UUID shape (not merely a
 * non-empty string) keeps a truncated or placeholder stamp from resolving to an id that can never
 * match a registry entry — which would read as `"dead"` rather than `"unknown"`.
 *
 * An absent or unrecognized `ownerKind` reads `"launcher"`: every stamp the hook has ever written
 * carries the spawning session, so that is what a legacy (pre-#4001) stamp means — the permissive
 * reading would be to assume the narrower `"occupant"`, which is precisely the over-claim to avoid.
 */
export const parseOwnerStamp = (raw: string): OwnerStamp | null => {
	const parsed = parseJson(raw);
	const sessionId = asString(objectField(parsed, "sessionId"));
	if (!SESSION_UUID.test(sessionId)) return null;
	const kind = asString(objectField(parsed, "ownerKind"));
	return {sessionId, kind: kind === "occupant" ? "occupant" : "launcher"};
};

/**
 * The owning session id recovered from a worktree's own path — the fallback for a `$TMPDIR`-rooted
 * `review-head-*` tree, which no hook provisions and so carries no stamp. This is a `"launcher"`
 * identity like the stamp is: the UUID roots the *pane's* scratchpad, not the review subagent that
 * materialized the head inside it. Matches only a segment
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
 *
 * A live owner splits on WHOSE identity the stamp carries (#4001): an `"occupant"` stamp names the
 * agent holding the tree, so its liveness is real presence (`"alive"`, KEEP); a `"launcher"` stamp
 * names the spawning session, whose liveness is not evidence about the occupant (`"launcher-alive"`).
 */
export const resolveOwnerLiveness = (args: {
	readonly owner: OwnerStamp | null;
	readonly liveSessionIds: ReadonlySet<string> | null;
}): OwnerLiveness => {
	if (args.liveSessionIds === null || args.owner === null) return "unknown";
	if (!args.liveSessionIds.has(args.owner.sessionId.toLowerCase())) return "dead";
	return args.owner.kind === "occupant" ? "alive" : "launcher-alive";
};
