import {describe, expect, it, vi} from "vitest";
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import {isAuthRedirectError} from "../pano/useVoteToggle";
import {nextReaction, type OptimisticReactionAggregate, reactionOptimistic} from "./reactionModel";
import type {ReactDispatch} from "./useReactionBar";

// The harness below re-models `useReactionBar`'s tap body rather than rendering the hook:
// the hook is a thin `useCallback`/`useSession` wrapper, and this drives the real payload
// and error logic. Keep the two in step when either changes.
function reactHarness(aggregate: ReactionAggregate | null | undefined) {
	const calls: Array<{emoji: ReactionEmoji | null; optimistic: OptimisticReactionAggregate}> = [];
	let rejectWith: unknown = null;
	const redirected = vi.fn();

	const dispatch: ReactDispatch = async ({emoji, optimistic}) => {
		calls.push({emoji, optimistic});
		if (rejectWith !== null) throw rejectWith;
		return {result: {}, error: null};
	};

	const onReact = async (tapped: ReactionEmoji) => {
		const current = aggregate?.myReaction ?? null;
		const emoji = nextReaction(current, tapped);
		const optimistic = reactionOptimistic(aggregate, tapped);
		try {
			await dispatch({emoji, optimistic});
		} catch (error) {
			if (isAuthRedirectError(error)) redirected();
		}
	};

	return {calls, onReact, redirected, failNext: (e: unknown) => (rejectWith = e)};
}

describe("useReactionBar tap→dispatch — react / change / retract routing", () => {
	it("a fresh react fires the mutation with the tapped emoji and its optimistic aggregate", async () => {
		const h = reactHarness({counts: [], myReaction: null});
		await h.onReact("👍");
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.emoji).toBe("👍");
		expect(h.calls[0]?.optimistic).toEqual({counts: [{emoji: "👍", count: 1}], myReaction: "👍"});
	});

	it("tapping the current reaction fires a retract (emoji: null) with the retracted aggregate", async () => {
		const h = reactHarness({counts: [{emoji: "❤️", count: 1}], myReaction: "❤️"});
		await h.onReact("❤️");
		expect(h.calls[0]?.emoji).toBeNull();
		expect(h.calls[0]?.optimistic).toEqual({counts: [], myReaction: null});
	});

	it("tapping another reaction fires a change to it", async () => {
		const h = reactHarness({
			counts: [
				{emoji: "👍", count: 1},
				{emoji: "🔥", count: 2},
			],
			myReaction: "👍",
		});
		await h.onReact("🔥");
		expect(h.calls[0]?.emoji).toBe("🔥");
		expect(h.calls[0]?.optimistic.myReaction).toBe("🔥");
	});
});

describe("useReactionBar tap→dispatch — reconcile-on-fail", () => {
	it("a rejected mutation is caught (nothing throws past the handler) — fate rolls the optimistic write back", async () => {
		const h = reactHarness({counts: [], myReaction: null});
		h.failNext({code: "INTERNAL_SERVER_ERROR"});
		await expect(h.onReact("👍")).resolves.toBeUndefined();
		expect(h.redirected).not.toHaveBeenCalled();
	});

	it("an UNAUTHORIZED rejection redirects to auth", async () => {
		const h = reactHarness({counts: [], myReaction: null});
		h.failNext({code: "UNAUTHORIZED"});
		await h.onReact("👍");
		expect(h.redirected).toHaveBeenCalledTimes(1);
	});
});
