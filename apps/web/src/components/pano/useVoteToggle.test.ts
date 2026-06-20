import {describe, expect, it} from "vitest";
import {nextVoteAction, runVoteLoop, type VoteAction, type VoteLoopState} from "./useVoteToggle";

/**
 * A controllable harness modelling the hook's refs + a fate dispatch that
 * settles only when we tell it to — so a test can interleave a "supersede"
 * toggle while a dispatch is still in flight, reproducing the #818 race
 * deterministically (no timers, no DOM).
 */
function harness(initialVoted: boolean) {
	let voted = initialVoted;
	let desired: boolean | null = null;
	const calls: VoteAction[] = [];
	let pending: (() => void) | null = null;

	const state = (): VoteLoopState => ({
		desired,
		clearDesired: () => {
			desired = null;
		},
		read: () => ({
			voted,
			dispatch: (action) =>
				new Promise<void>((resolve) => {
					calls.push(action);
					pending = () => {
						// The optimistic write + server reconcile lands voted-state.
						voted = action === "vote";
						pending = null;
						resolve();
					};
				}),
		}),
	});

	return {
		calls,
		setDesired: (v: boolean) => {
			desired = v;
		},
		/** Settle the currently in-flight dispatch. */
		settle: () => {
			if (!pending) throw new Error("no dispatch in flight to settle");
			pending();
		},
		hasPending: () => pending != null,
		run: () => runVoteLoop(state),
	};
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("nextVoteAction", () => {
	it("is null when achieved already matches desired (no same-action double-fire)", () => {
		expect(nextVoteAction(false, false)).toBeNull();
		expect(nextVoteAction(true, true)).toBeNull();
	});
	it("votes to reach desired-true, retracts to reach desired-false", () => {
		expect(nextVoteAction(false, true)).toBe("vote");
		expect(nextVoteAction(true, false)).toBe("retract");
	});
});

describe("runVoteLoop — the #818 race", () => {
	it("does NOT drop a retract issued while the vote mutation is still in flight", async () => {
		const h = harness(false);

		// Click 1: vote. Starts the loop; first dispatch is now in flight.
		h.setDesired(true);
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["vote"]);
		expect(h.hasPending()).toBe(true);

		// Click 2 lands INSIDE the in-flight window (the bug's exact timing) —
		// supersede the desired end-state back to "not voted".
		h.setDesired(false);

		// The vote POST resolves only now (its ~370ms round-trip).
		h.settle();
		await tick();

		// The retract MUST fire — under the old `if (inFlight) return;` it never did.
		expect(h.calls).toEqual(["vote", "retract"]);
		expect(h.hasPending()).toBe(true);
		h.settle();
		await loop;
		expect(h.calls).toEqual(["vote", "retract"]);
	});

	it("collapses vote→unvote→vote (back to the start) to a single in-flight vote", async () => {
		const h = harness(false);

		h.setDesired(true); // click 1
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["vote"]);

		// Two more clicks while in flight: unvote then vote → desired ends at true,
		// which the in-flight vote already achieves, so no corrective dispatch.
		h.setDesired(false);
		h.setDesired(true);

		h.settle();
		await loop;
		expect(h.calls).toEqual(["vote"]);
	});

	it("serializes — only one dispatch is in flight at any time", async () => {
		const h = harness(false);
		h.setDesired(true);
		const loop = h.run();
		await tick();
		// A second click while the first is pending must NOT start a parallel POST.
		h.setDesired(false);
		await tick();
		expect(h.calls).toEqual(["vote"]); // still just the first, second is queued
		h.settle();
		await tick();
		expect(h.calls).toEqual(["vote", "retract"]);
		h.settle();
		await loop;
	});
});
