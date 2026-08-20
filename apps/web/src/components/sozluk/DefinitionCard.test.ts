import {describe, expect, it, vi} from "vitest";
import {runToggleLoop, type ToggleAction, type ToggleLoopState} from "../pano/useToggleAction";
import {isAuthRedirectError, type VoteMutations, voteOptimistic} from "../pano/useVoteToggle";

// The harness drives the REAL exported seam — `voteOptimistic` / `isAuthRedirectError` /
// `runToggleLoop`, the same functions the hook routes through — never a re-implemented copy.
function voteHarness(args: {initialVoted: boolean; initialScore: number}) {
	let voted = args.initialVoted;
	const score = args.initialScore;
	let desired: boolean | null = null;
	const calls: ToggleAction[] = [];
	const optimistic: ReturnType<typeof voteOptimistic>[] = [];
	let pending: (() => void) | null = null;

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
		expect(h.optimistic).toEqual([{score: 0, myVote: false}]);
		h.settle();
		await loop;
		expect(h.optimistic.every((o) => o.score >= 0)).toBe(true);
	});

	it("does NOT drop a retract issued while the vote mutation is still in flight (#818/#865)", async () => {
		const h = voteHarness({initialVoted: false, initialScore: 3});

		h.setDesired(true);
		const loop = h.run();
		await tick();
		expect(h.calls).toEqual(["set"]);
		expect(h.hasPending()).toBe(true);

		// The second click lands INSIDE the in-flight window — supersede back to "not voted".
		h.setDesired(false);
		h.settle();
		await tick();

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
		expect(redirectToAuth).toHaveBeenCalledTimes(1);
	});
});
