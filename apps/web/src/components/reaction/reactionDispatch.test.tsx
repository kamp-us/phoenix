import {act, renderHook} from "@testing-library/react";
import type {ReactNode} from "react";
import {MemoryRouter, useLocation} from "react-router";
import {describe, expect, it, vi} from "vitest";
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";
import type {ReactionAggregate} from "../../../worker/features/reaction/Reaction";
import type {OptimisticReactionAggregate} from "./reactionModel";
import {useReactionBar} from "./useReactionBar";

vi.mock("../../auth/client", () => ({
	useSession: () => ({data: {user: {id: "u1"}}, isPending: false}),
}));

function reactHarness(aggregate: ReactionAggregate | null | undefined, rejectWith?: unknown) {
	const calls: Array<{emoji: ReactionEmoji | null; optimistic: OptimisticReactionAggregate}> = [];
	const wrapper = ({children}: {children: ReactNode}) => (
		<MemoryRouter initialEntries={["/pano/p"]}>{children}</MemoryRouter>
	);
	const {result} = renderHook(
		() => ({
			onReact: useReactionBar({
				aggregate,
				returnTo: () => "/pano/p",
				dispatch: async (args) => {
					calls.push(args);
					if (rejectWith !== undefined) throw rejectWith;
				},
			}),
			location: useLocation(),
		}),
		{wrapper},
	);
	const tap = async (emoji: ReactionEmoji) => {
		await act(async () => result.current.onReact(emoji));
	};
	return {calls, tap, result};
}

describe("useReactionBar tap→dispatch — react / retract routing", () => {
	it("a fresh react fires the mutation with the tapped emoji and its optimistic aggregate", async () => {
		const h = reactHarness({counts: [], myReaction: null});
		await h.tap("👍");
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.emoji).toBe("👍");
		expect(h.calls[0]?.optimistic).toEqual({counts: [{emoji: "👍", count: 1}], myReaction: "👍"});
	});

	it("tapping the current reaction fires a retract (emoji: null) with the retracted aggregate", async () => {
		const h = reactHarness({counts: [{emoji: "❤️", count: 1}], myReaction: "❤️"});
		await h.tap("❤️");
		expect(h.calls[0]?.emoji).toBeNull();
		expect(h.calls[0]?.optimistic).toEqual({counts: [], myReaction: null});
	});
});

describe("useReactionBar tap→dispatch — reconcile-on-fail", () => {
	it("a rejected mutation is caught (nothing throws past the handler) — fate rolls the optimistic write back", async () => {
		const h = reactHarness({counts: [], myReaction: null}, {code: "INTERNAL_SERVER_ERROR"});
		await h.tap("👍");
		expect(h.calls).toHaveLength(1);
		expect(h.result.current.location.pathname).toBe("/pano/p");
	});

	it("an UNAUTHORIZED rejection redirects to auth", async () => {
		const h = reactHarness({counts: [], myReaction: null}, {code: "UNAUTHORIZED"});
		await h.tap("👍");
		const {pathname, search} = h.result.current.location;
		expect(`${pathname}${search}`).toBe(`/auth?returnTo=${encodeURIComponent("/pano/p")}`);
	});
});
