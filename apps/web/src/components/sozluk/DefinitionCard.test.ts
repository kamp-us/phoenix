import {describe, expect, it, vi} from "vitest";
import {runToggleLoop, type ToggleAction, type ToggleLoopState} from "../pano/useToggleAction";
import {isAuthRedirectError, type VoteMutations, voteOptimistic} from "../pano/useVoteToggle";

/**
 * Covers the load-bearing vote logic DefinitionCard ships through `useVoteToggle`
 * (`DefinitionCard.tsx` → `useVoteToggle`): the optimistic `{score, myVote}`
 * delta with the `Math.max(0, score - 1)` retract floor, and the
 * `UNAUTHORIZED`→auth-redirect classification on the dispatch error channel.
 *
 * It exercises the REAL exported seam — `voteOptimistic` / `isAuthRedirectError`
 * from `useVoteToggle`, the same functions the hook's `dispatch` routes through —
 * not a re-implemented copy. The earlier version of this file imported
 * `runToggleLoop` and asserted a `useToggleAction` contract DefinitionCard never
 * had (already owned by `useToggleAction.test.ts`), while the vote delta + the
 * auth-redirect shipped green untested; this drives the actual code, so a break
 * in the score floor, the `myVote` boolean, or the redirect classification fails
 * here rather than only in an e2e.
 *
 * The hook (`useGatedToggle`/`useToggleAction`) is a React ref/`useCallback`
 * wrapper around `runToggleLoop`; the loop itself is the real driver, modelled
 * here over the same controllable dispatch idiom as `useToggleAction.test.ts` so
 * the serialize-and-supersede behavior the hook relies on is real, not mocked.
 */
function voteHarness(args: {initialVoted: boolean; initialScore: number}) {
	let voted = args.initialVoted;
	const score = args.initialScore;
	let desired: boolean | null = null;
	const calls: ToggleAction[] = [];
	const optimistic: ReturnType<typeof voteOptimistic>[] = [];
	let pending: (() => void) | null = null;

	// The exact mutation pair DefinitionCard hands `useVoteToggle`, capturing the
	// optimistic payload the hook computes via `voteOptimistic`.
	const mutations: VoteMutations = {
		vote: (o) =>
			new Promise<void>((resolve) => {
				optimistic.push(o);
				pending = () => {
					voted = true;
					pending = null;
					resolve();
				};
			}),
		retractVote: (o) =>
			new Promise<void>((resolve) => {
				optimistic.push(o);
				pending = () => {
					voted = false;
					pending = null;
					resolve();
				};
			}),
	};

	// The hook's real dispatch body (useVoteToggle → useGatedToggle): route the
	// action through the REAL `voteOptimistic`, then fire the matching mutation.
	const dispatch = async (action: ToggleAction): Promise<void> => {
		calls.push(action);
		const o = voteOptimistic(action, score);
		if (o.myVote) await mutations.vote(o);
		else await mutations.retractVote(o);
	};

	const state = (): ToggleLoopState => ({
		desired,
		clearDesired: () => {
			desired = null;
		},
		read: () => ({on: voted, dispatch}),
	});

	return {
		calls,
		optimistic,
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

describe("DefinitionCard vote — optimistic delta via the real useVoteToggle", () => {
	it("votes with score + 1 and myVote: true", async () => {
		const h = voteHarness({initialVoted: false, initialScore: 3});
		h.setDesired(true);
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["set"]);
		expect(h.optimistic).toEqual([{score: 4, myVote: true}]);
		h.settle();
		await loop;
	});

	it("retracts with Math.max(0, score - 1) and myVote: false", async () => {
		const h = voteHarness({initialVoted: true, initialScore: 5});
		h.setDesired(false);
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["unset"]);
		expect(h.optimistic).toEqual([{score: 4, myVote: false}]);
		h.settle();
		await loop;
	});

	it("floors the optimistic score at 0 on retract — never a negative score", async () => {
		const h = voteHarness({initialVoted: true, initialScore: 0});
		h.setDesired(false);
		const loop = h.run();
		await tick();
		// Math.max(0, 0 - 1) === 0, not -1.
		expect(h.optimistic).toEqual([{score: 0, myVote: false}]);
		h.settle();
		await loop;
		expect(h.optimistic.every((o) => o.score >= 0)).toBe(true);
	});

	it("does NOT drop a retract issued while the vote mutation is still in flight (#818/#865)", async () => {
		const h = voteHarness({initialVoted: false, initialScore: 3});

		// Click 1: vote. The vote POST is now in flight.
		h.setDesired(true);
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["set"]);
		expect(h.hasPending()).toBe(true);

		// Click 2 lands INSIDE the in-flight window — supersede back to "not voted".
		h.setDesired(false);
		h.settle();
		await tick();

		// The retract MUST fire, with its own floored optimistic payload.
		expect(h.calls).toEqual(["set", "unset"]);
		expect(h.optimistic).toEqual([
			{score: 4, myVote: true},
			{score: 2, myVote: false},
		]);
		h.settle();
		await loop;
	});
});

describe("DefinitionCard vote — the UNAUTHORIZED→auth-redirect classification (real isAuthRedirectError)", () => {
	it("classifies an UNAUTHORIZED throw as an auth redirect", () => {
		expect(isAuthRedirectError({code: "UNAUTHORIZED"})).toBe(true);
	});

	it("leaves every other dispatch error silent (no redirect)", () => {
		expect(isAuthRedirectError({code: "DEFINITION_NOT_FOUND"})).toBe(false);
		expect(isAuthRedirectError(new Error("network"))).toBe(false);
		expect(isAuthRedirectError(undefined)).toBe(false);
	});

	it("redirects on the UNAUTHORIZED path the gate's dispatch catch takes", async () => {
		// Model the gate's caught-error branch (useGatedToggle): catch the dispatch
		// throw, redirect iff `isAuthRedirectError` — using the REAL classifier.
		const redirectToAuth = vi.fn();
		const guarded = async (dispatch: () => Promise<void>) => {
			try {
				await dispatch();
			} catch (error) {
				if (isAuthRedirectError(error)) redirectToAuth();
			}
		};

		await guarded(() => Promise.reject({code: "UNAUTHORIZED"}));
		expect(redirectToAuth).toHaveBeenCalledTimes(1);

		await guarded(() => Promise.reject({code: "INTERNAL_SERVER_ERROR"}));
		expect(redirectToAuth).toHaveBeenCalledTimes(1); // unchanged — stays silent
	});
});
