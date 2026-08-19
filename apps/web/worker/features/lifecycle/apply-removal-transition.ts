/**
 * The caller-side remove/restore wrapper every public remove/restore method shares;
 * `removal.ts` owns the write sequence itself.
 *
 * The refresh policy is load-bearing: the transition commits BEFORE the refresh, and the
 * refresh runs over `DrizzleAccessOrDie`, so a D1 hiccup there dies. Swallowing it in
 * EVERY arm is what stops an already-committed transition turning into a raw 500; totals
 * reconverge on the next write.
 */
import {Effect} from "effect";
import * as Removal from "./removal.ts";

export type TransitionSubject = Removal.RemovalColumns;

/**
 * `committed: false` is the no-op — the row was already in the target state. The
 * `sandboxedAt` on the committed arm is what a restore's broadcast decision reads.
 */
export type RemovalTransitionOutcome =
	| {readonly committed: false}
	| {readonly committed: true; readonly sandboxedAt: Date | null};

const noop: RemovalTransitionOutcome = {committed: false};

/**
 * The swallow-and-log policy above, shared by the removal/restore arms and the create
 * paths that commit-then-refresh.
 */
export const swallowRefresh = (label: string, refresh: Effect.Effect<void>): Effect.Effect<void> =>
	refresh.pipe(
		Effect.catchCause((cause) => Effect.logWarning(`${label}: cache refresh failed`, cause)),
	);

/**
 * Apply a remove/restore for one already-loaded, already-authorized entity. The caller
 * owns the not-found and authority envelopes; this owns the state guard, the column
 * stamp, the substrate write, and the refresh policy. `afterCommit` is the plane-specific
 * bookkeeping that is NOT part of that invariant, run after the write, before the refresh.
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
