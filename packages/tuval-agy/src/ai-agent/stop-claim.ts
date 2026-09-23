/**
 * Which child a stop was delivered to, as the one thing that can be asked about it.
 *
 * Two presses of Escape race, and a guard that reads the memory and then writes it is two steps:
 * both presses find the stop unclaimed, both send SIGINT, and the second tears down the child the
 * first just reopened (#8883). The claim is therefore one `Ref.modify` — and the `Ref` lives here,
 * reachable through nothing but `claim` / `heldBy` / `release`, so the read-then-write shape is not
 * something a caller can spell again (#8940). That is the whole reason this is a module and not
 * three lines inside `AgyAiAgent`: the interleave cannot be pinned by a test — it exists only
 * between two adjacent synchronous ops, which no latch a test owns can split — so it is closed by
 * construction instead.
 *
 * The claim names the *child* rather than being a layer-wide flag: a relaunch whose `openSession`
 * failed would otherwise leave a boolean stale-`true` and the next child's own death would read as a
 * stop nobody sent (#8709).
 */

import {Effect, Ref} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";

export interface StopClaim {
	/**
	 * Take the stop for one child. `true` to the press that owns it, `false` to every later press
	 * while that child's stop is still in flight — which is all a second press has to be told.
	 */
	readonly claim: (handle: ChildProcessSpawner.ChildProcessHandle) => Effect.Effect<boolean>;
	/**
	 * Whether the stop in flight is this child's. `processGone` spends it where the wire said
	 * nothing (`refusals.ts`), and the exit watch reads it to tell an exit this layer asked for from
	 * one it did not.
	 */
	readonly heldBy: (handle: ChildProcessSpawner.ChildProcessHandle) => Effect.Effect<boolean>;
	/**
	 * Give back this child's claim, for a signal the backend refused: one never delivered speaks
	 * for nothing. Named to its child like the other two, and it clears only that child's claim: a
	 * release for a child the stop no longer names is a no-op, not a theft of the claim a later child
	 * holds.
	 */
	readonly release: (handle: ChildProcessSpawner.ChildProcessHandle) => Effect.Effect<void>;
}

export const makeStopClaim: Effect.Effect<StopClaim> = Effect.map(
	Ref.make<ChildProcessSpawner.ChildProcessHandle | null>(null),
	(held) => ({
		claim: (handle) =>
			Ref.modify(held, (current) => (current === handle ? [false, current] : [true, handle])),
		heldBy: (handle) => Effect.map(Ref.get(held), (current) => current === handle),
		release: (handle) => Ref.update(held, (current) => (current === handle ? null : current)),
	}),
);
