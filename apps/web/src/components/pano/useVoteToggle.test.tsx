import {ToastProvider} from "@kampus/design";
import {act, renderHook, screen} from "@testing-library/react";
import type {ReactNode} from "react";
import {MemoryRouter, useLocation} from "react-router";
import {describe, expect, it, vi} from "vitest";
import {en} from "../../i18n/en";
import type {Translate} from "../../i18n/LocaleProvider";
import {tr} from "../../i18n/tr";
import {useGatedToggle, useVoteToggle, voteGateMessage} from "./useVoteToggle";

vi.mock("../../auth/client", () => ({
	useSession: () => ({data: {user: {id: "u1"}}, isPending: false}),
}));

/**
 * The shared vote-seam error classification (#1879). These run the REAL exported
 * classifiers, not a re-implemented copy, so a regression fails here and not only
 * in an e2e.
 */

const trT: Translate = (key) => tr[key];
const enT: Translate = (key) => en[key];

describe("voteGateMessage — the VOTE_REQUIRES_YAZAR ladder copy (real classifier)", () => {
	it("maps a VOTE_REQUIRES_YAZAR throw to the ladder copy", () => {
		expect(voteGateMessage(trT, {code: "VOTE_REQUIRES_YAZAR"})).toBe(
			"yazar olunca oy verebilirsin",
		);
	});

	it("resolves the copy from the catalog, not a hand-copied literal", () => {
		expect(voteGateMessage(trT, {code: "VOTE_REQUIRES_YAZAR"})).toBe(
			tr["wire.VOTE_REQUIRES_YAZAR"],
		);
		expect(voteGateMessage(enT, {code: "VOTE_REQUIRES_YAZAR"})).toBe(
			en["wire.VOTE_REQUIRES_YAZAR"],
		);
	});

	it("returns null for UNAUTHORIZED — that code redirects, it is not toasted", () => {
		expect(voteGateMessage(trT, {code: "UNAUTHORIZED"})).toBeNull();
	});

	it("returns null for every other code (stays silent)", () => {
		expect(voteGateMessage(trT, {code: "FORBIDDEN"})).toBeNull();
		expect(voteGateMessage(trT, {code: "INTERNAL_SERVER_ERROR"})).toBeNull();
		expect(voteGateMessage(trT, new Error("network"))).toBeNull();
		expect(voteGateMessage(trT, undefined)).toBeNull();
	});
});

describe("useGatedToggle's dispatch catch — redirect vs toast vs silent", () => {
	function tapRejecting(error: unknown) {
		const wrapper = ({children}: {children: ReactNode}) => (
			<MemoryRouter initialEntries={["/pano/p"]}>
				<ToastProvider>{children}</ToastProvider>
			</MemoryRouter>
		);
		const {result} = renderHook(
			() => ({
				tap: useGatedToggle({
					on: false,
					returnTo: () => "/pano/p",
					dispatch: () => Promise.reject(error),
				}),
				location: useLocation(),
			}),
			{wrapper},
		);
		return result;
	}

	it("toasts the ladder copy on a çaylak's VOTE_REQUIRES_YAZAR — not a silent no-op", async () => {
		const result = tapRejecting({code: "VOTE_REQUIRES_YAZAR"});
		await act(async () => result.current.tap());
		expect((await screen.findByTestId("toast-vote-gate")).textContent).toContain(
			"yazar olunca oy verebilirsin",
		);
		expect(result.current.location.pathname).toBe("/pano/p");
	});

	it("still redirects on UNAUTHORIZED and never toasts (path unchanged)", async () => {
		const result = tapRejecting({code: "UNAUTHORIZED"});
		await act(async () => result.current.tap());
		expect(`${result.current.location.pathname}${result.current.location.search}`).toBe(
			`/auth?returnTo=${encodeURIComponent("/pano/p")}`,
		);
		expect(screen.queryByTestId("toast-vote-gate")).toBeNull();
	});

	it("stays silent on every other code — no redirect, no toast", async () => {
		const result = tapRejecting({code: "INTERNAL_SERVER_ERROR"});
		await act(async () => result.current.tap());
		expect(result.current.location.pathname).toBe("/pano/p");
		expect(screen.queryByTestId("toast-vote-gate")).toBeNull();
	});
});

// Every vote site (pano posts and comments, sözlük definitions) routes through this hook, so the
// optimistic delta and the vote / retract choice are pinned here once, on the real hook.
describe("useVoteToggle — the optimistic vote delta", () => {
	it.each([
		{voted: false, score: 3, mutation: "vote", optimistic: {score: 4, myVote: true}},
		{voted: true, score: 5, mutation: "retractVote", optimistic: {score: 4, myVote: false}},
		{voted: true, score: 0, mutation: "retractVote", optimistic: {score: 0, myVote: false}},
	])("voted=$voted at score $score sends $mutation with score $optimistic.score", async (row) => {
		const calls: Array<{mutation: string; optimistic: unknown}> = [];
		const wrapper = ({children}: {children: ReactNode}) => (
			<MemoryRouter>
				<ToastProvider>{children}</ToastProvider>
			</MemoryRouter>
		);
		const {result} = renderHook(
			() =>
				useVoteToggle({
					voted: row.voted,
					score: row.score,
					returnTo: () => "/",
					mutations: {
						vote: async (optimistic) => void calls.push({mutation: "vote", optimistic}),
						retractVote: async (optimistic) =>
							void calls.push({mutation: "retractVote", optimistic}),
					},
				}),
			{wrapper},
		);
		await act(async () => result.current());
		expect(calls).toEqual([{mutation: row.mutation, optimistic: row.optimistic}]);
	});
});
