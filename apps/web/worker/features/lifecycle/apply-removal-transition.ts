/**
 * The remove/restore *ceremony*, single-sourced (#2012). `removal.ts` already owns the
 * write SEQUENCE ({@link Removal.removeEntity}/{@link Removal.restoreEntity}, #1129); this
 * module owns the CALLER-side wrapper that every public remove/restore method (pano post,
 * pano comment, sözlük definition — author path + moderator path) had hand-inlined and
 * silently drifted:
 *
 *   `fromColumns` → `isRemoved` short-circuit → `remove`/`restore` + `toColumns` →
 *   `removeEntity`/`restoreEntity` → (plane side-effects) → recomputable-cache refresh
 *
 * The three arms differed only in the authorization gate, the `RemovalReason`, and the
 * result envelope — all of which stay at the call site. What is invariant — the state
 * guard, the column stamp, the substrate write, and the **stats-refresh policy** — lives
 * here, so a site can no longer forget a step or drift a policy.
 *
 * The refresh policy is uniform and load-bearing (#2012, #1639): the removal/restore is
 * committed BEFORE the refresh, and the refresh is a recomputable cache (ADR 0011/0117)
 * running over `DrizzleAccessOrDie` — a D1 hiccup there *dies*, and that must NOT flip an
 * already-committed transition into a raw 500 (the partial-commit-then-500). So the refresh
 * is swallowed-and-logged for EVERY arm (it was swallowed only in `deletePost`, bare in the
 * other eleven — the exact drift copy-pasted ceremony breeds). Totals recompute next write.
 */
import {Effect} from "effect";
import * as Removal from "./removal.ts";

/**
 * A load→guard→transition subject: the already-loaded row's lifecycle columns plus the
 * pre-transition `sandboxedAt` marker the substrate preserves for a faithful round-trip
 * (#1811). The caller loads the row (its not-found + authority envelopes are its own);
 * this is the slice the transition reads.
 */
export type TransitionSubject = Removal.RemovalColumns;

/**
 * The uniform outcome of {@link applyRemovalTransition}. `committed` distinguishes the
 * no-op (already in the target state — the `isRemoved` short-circuit) from the applied
 * transition, and carries the stamped `sandboxedAt` a restore's broadcast decision reads.
 * A caller maps this to its result envelope; it cannot reach the transition without going
 * through the state guard.
 */
export type RemovalTransitionOutcome =
	| {readonly committed: false}
	| {readonly committed: true; readonly sandboxedAt: Date | null};

const noop: RemovalTransitionOutcome = {committed: false};

/**
 * Wrap a recomputable-cache refresh in the uniform swallow-and-log (#2012, #1639): the
 * write it follows has already committed, so a refresh die (a recomputable cache over
 * `DrizzleAccessOrDie`, ADR 0011/0117) must not flip it into a raw 500 — totals reconverge
 * on the next write. One place, so the removal/restore arms AND the create paths that
 * committed-then-refresh (`addDefinition`, `submitPost`, #2556) share the single policy.
 */
export const swallowRefresh = (label: string, refresh: Effect.Effect<void>): Effect.Effect<void> =>
	refresh.pipe(
		Effect.catchCause((cause) => Effect.logWarning(`${label}: cache refresh failed`, cause)),
	);

/**
 * Apply a remove/restore onto the substrate for one already-loaded, already-authorized
 * entity: state-guard → column stamp → `removeEntity`/`restoreEntity` → plane side-effects
 * → swallowed cache refresh. Returns {@link RemovalTransitionOutcome}; the no-op short-circuit
 * returns before any write.
 *
 * `afterCommit` runs after the substrate write and before the refresh — the plane-specific
 * bookkeeping that is NOT part of the invariant (pano's post `comment_count` adjustment,
 * sözlük's term-summary rebuild); pass `Effect.void` where there is none. `refresh` is the
 * recomputable stats/cache refresh, swallowed uniformly.
 */
export const applyRemovalTransition = <E = never, R = never>(
	args: {
		readonly label: string;
		readonly seq: Removal.RemovalSequence;
		readonly subject: TransitionSubject;
		readonly now: Date;
		readonly refresh: Effect.Effect<void>;
		readonly afterCommit?: (sandboxedAt: Date | null) => Effect.Effect<void, E, R>;
	} & (
		| {
				readonly transition: "remove";
				readonly target: Removal.RemoveTarget;
				readonly removedBy: string;
				readonly reason: Removal.RemovalReason;
		  }
		| {
				readonly transition: "restore";
				readonly target: Removal.RestoreTarget;
		  }
	),
): Effect.Effect<RemovalTransitionOutcome, E, R> =>
	Effect.gen(function* () {
		const current = Removal.fromColumns(args.subject);

		if (args.transition === "remove") {
			if (Removal.isRemoved(current)) return noop;
			const removed = Removal.toColumns(
				Removal.remove({
					removedAt: args.now,
					removedBy: args.removedBy,
					reason: args.reason,
					// Preserve the pre-transition sandbox marker so a çaylak's sandboxed content
					// round-trips back to Sandboxed on restore, never self-escaping to Live (#1811).
					sandboxedAt: Removal.sandboxedAtOf(current),
				}),
			);
			yield* Removal.removeEntity(args.seq, args.target, removed, args.now);
			if (args.afterCommit) yield* args.afterCommit(removed.sandboxedAt);
			yield* swallowRefresh(args.label, args.refresh);
			return {committed: true, sandboxedAt: removed.sandboxedAt};
		}

		if (!Removal.isRemoved(current)) return noop;
		const live = Removal.toColumns(Removal.restore(current));
		yield* Removal.restoreEntity(args.seq, args.target, live, args.now);
		if (args.afterCommit) yield* args.afterCommit(live.sandboxedAt);
		yield* swallowRefresh(args.label, args.refresh);
		return {committed: true, sandboxedAt: live.sandboxedAt};
	});
