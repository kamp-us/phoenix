import {describe, expect, it} from "vitest";
import {runToggleLoop, type ToggleAction, type ToggleLoopState} from "../pano/useToggleAction";

/**
 * Pins the #818 in-flight-toggle race fix for sözlük definition votes (#865):
 * DefinitionCard now drives its vote through `useToggleAction` instead of a local
 * `inFlight` boolean. This harness models DefinitionCard's vote `dispatch` —
 * `set` → `definition.vote` (score+1), `unset` → `definition.retractVote`
 * (score floored at 0) — settling only when told, so a "supersede" toggle can
 * interleave while a dispatch is still in flight (the bug's exact timing).
 */
function definitionVoteHarness(args: {initialVoted: boolean; initialScore: number}) {
	let voted = args.initialVoted;
	let score = args.initialScore;
	let desired: boolean | null = null;
	const calls: ToggleAction[] = [];
	const scores: number[] = [];
	let pending: (() => void) | null = null;

	const state = (): ToggleLoopState => ({
		desired,
		clearDesired: () => {
			desired = null;
		},
		read: () => ({
			on: voted,
			dispatch: (action) =>
				new Promise<void>((resolve) => {
					calls.push(action);
					// The same optimistic score math DefinitionCard's dispatch applies.
					score = action === "unset" ? Math.max(0, score - 1) : score + 1;
					scores.push(score);
					pending = () => {
						voted = action === "set";
						pending = null;
						resolve();
					};
				}),
		}),
	});

	return {
		calls,
		score: () => score,
		scores,
		setDesired: (v: boolean) => {
			desired = v;
		},
		settle: () => {
			if (!pending) throw new Error("no dispatch in flight to settle");
			pending();
		},
		hasPending: () => pending != null,
		run: () => runToggleLoop(state),
	};
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("DefinitionCard vote — the #818/#865 in-flight-toggle race", () => {
	it("does NOT drop a retract issued while the vote mutation is still in flight", async () => {
		const h = definitionVoteHarness({initialVoted: false, initialScore: 3});

		// Click 1: vote. Starts the loop; the vote POST is now in flight.
		h.setDesired(true);
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["set"]);
		expect(h.hasPending()).toBe(true);

		// Click 2 lands INSIDE the in-flight window — supersede back to "not voted".
		// Under the old `if (inFlight) return;` guard this second intent was dropped.
		h.setDesired(false);

		h.settle(); // the vote POST resolves only now (its ~370ms round-trip)
		await tick();

		// The retract MUST fire — and the score settles back to the user's final intent.
		expect(h.calls).toEqual(["set", "unset"]);
		expect(h.hasPending()).toBe(true);
		h.settle();
		await loop;
		expect(h.calls).toEqual(["set", "unset"]);
		expect(h.score()).toBe(3);
	});

	it("floors the optimistic score at 0 on retract (never shows a negative score)", async () => {
		const h = definitionVoteHarness({initialVoted: true, initialScore: 0});

		h.setDesired(false); // retract from an already-zero score
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["unset"]);
		expect(h.score()).toBe(0); // Math.max(0, 0 - 1) — not -1
		h.settle();
		await loop;
		expect(h.scores.every((s) => s >= 0)).toBe(true);
	});

	it("collapses vote→unvote→vote (back to the start) to a single in-flight vote", async () => {
		const h = definitionVoteHarness({initialVoted: false, initialScore: 5});

		h.setDesired(true); // click 1
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["set"]);

		// Two more clicks mid-flight: unvote then vote → desired ends at voted, which
		// the in-flight vote already achieves, so no corrective dispatch fires.
		h.setDesired(false);
		h.setDesired(true);

		h.settle();
		await loop;
		expect(h.calls).toEqual(["set"]);
	});
});
