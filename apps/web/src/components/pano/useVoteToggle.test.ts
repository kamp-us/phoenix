import {describe, expect, it, vi} from "vitest";
import {WIRE_MESSAGES} from "../../fate/wireMessages";
import {isAuthRedirectError, voteGateMessage} from "./useVoteToggle";

/**
 * The shared vote-seam error classification (`useVoteToggle` / `useGatedToggle`):
 * a çaylak's earn-to-vote denial (`VOTE_REQUIRES_YAZAR`) is surfaced as a toast
 * instead of a silent no-op (#1879), while the pre-existing `UNAUTHORIZED`→
 * auth-redirect path and the silence of every other code are unchanged.
 *
 * These exercise the REAL exported classifiers — `voteGateMessage` /
 * `isAuthRedirectError`, the same functions the hook's `dispatch` catch routes
 * through — not a re-implemented copy, and model the gate's caught-error branch
 * over the same controllable dispatch idiom the sibling `DefinitionCard.test.ts`
 * uses, so a regression in the classification fails here rather than only in an
 * e2e.
 */

describe("voteGateMessage — the VOTE_REQUIRES_YAZAR ladder copy (real classifier)", () => {
	it("maps a VOTE_REQUIRES_YAZAR throw to the ladder copy", () => {
		expect(voteGateMessage({code: "VOTE_REQUIRES_YAZAR"})).toBe("yazar olunca oy verebilirsin");
	});

	it("resolves the copy from the shared WIRE_MESSAGES registry, not a hand-copied literal", () => {
		expect(voteGateMessage({code: "VOTE_REQUIRES_YAZAR"})).toBe(WIRE_MESSAGES.VOTE_REQUIRES_YAZAR);
	});

	it("returns null for UNAUTHORIZED — that code redirects, it is not toasted", () => {
		expect(voteGateMessage({code: "UNAUTHORIZED"})).toBeNull();
	});

	it("returns null for every other code (stays silent)", () => {
		expect(voteGateMessage({code: "FORBIDDEN"})).toBeNull();
		expect(voteGateMessage({code: "INTERNAL_SERVER_ERROR"})).toBeNull();
		expect(voteGateMessage(new Error("network"))).toBeNull();
		expect(voteGateMessage(undefined)).toBeNull();
	});
});

describe("the gate's dispatch catch — redirect vs toast vs silent (real classifiers)", () => {
	// Model the caught-error branch of useGatedToggle exactly: redirect iff
	// `isAuthRedirectError`, else toast iff `voteGateMessage`, else stay silent —
	// using the REAL classifiers so a break in either fails here.
	const guarded = async (
		dispatch: () => Promise<void>,
		redirectToAuth: () => void,
		show: (t: {id: string; message: string}) => void,
	) => {
		try {
			await dispatch();
		} catch (error) {
			if (isAuthRedirectError(error)) {
				redirectToAuth();
				return;
			}
			const message = voteGateMessage(error);
			if (message) show({id: "vote-gate", message});
		}
	};

	it("toasts the ladder copy on a çaylak's VOTE_REQUIRES_YAZAR — not a silent no-op", async () => {
		const redirectToAuth = vi.fn();
		const show = vi.fn();
		await guarded(() => Promise.reject({code: "VOTE_REQUIRES_YAZAR"}), redirectToAuth, show);
		expect(show).toHaveBeenCalledTimes(1);
		expect(show).toHaveBeenCalledWith({id: "vote-gate", message: "yazar olunca oy verebilirsin"});
		expect(redirectToAuth).not.toHaveBeenCalled();
	});

	it("still redirects on UNAUTHORIZED and never toasts (path unchanged)", async () => {
		const redirectToAuth = vi.fn();
		const show = vi.fn();
		await guarded(() => Promise.reject({code: "UNAUTHORIZED"}), redirectToAuth, show);
		expect(redirectToAuth).toHaveBeenCalledTimes(1);
		expect(show).not.toHaveBeenCalled();
	});

	it("stays silent on every other code — no redirect, no toast", async () => {
		const redirectToAuth = vi.fn();
		const show = vi.fn();
		await guarded(() => Promise.reject({code: "INTERNAL_SERVER_ERROR"}), redirectToAuth, show);
		expect(redirectToAuth).not.toHaveBeenCalled();
		expect(show).not.toHaveBeenCalled();
	});
});

describe("WIRE_MESSAGES exhaustiveness holds for the new code", () => {
	it("carries a message for VOTE_REQUIRES_YAZAR", () => {
		// The registry is typed Record<FateWireCode, string>, so a missing entry is a
		// compile error; this pins the runtime value too (ladder framing, lowercase).
		expect(WIRE_MESSAGES.VOTE_REQUIRES_YAZAR).toBe("yazar olunca oy verebilirsin");
	});
});
