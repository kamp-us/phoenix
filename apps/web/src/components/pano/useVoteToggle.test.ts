import {describe, expect, it, vi} from "vitest";
import {en} from "../../i18n/en";
import type {Translate} from "../../i18n/LocaleProvider";
import {tr} from "../../i18n/tr";
import {isAuthRedirectError, voteGateMessage} from "./useVoteToggle";

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

describe("the gate's dispatch catch — redirect vs toast vs silent (real classifiers)", () => {
	// Mirrors useGatedToggle's caught-error branch, over the real classifiers.
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
			const message = voteGateMessage(trT, error);
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

describe("catalog coverage holds for the new code", () => {
	it("carries a message for VOTE_REQUIRES_YAZAR in both locales", () => {
		// A missing entry is already a compile error; this pins the runtime copy too.
		expect(tr["wire.VOTE_REQUIRES_YAZAR"]).toBe("yazar olunca oy verebilirsin");
		expect(en["wire.VOTE_REQUIRES_YAZAR"]).toBeTruthy();
	});
});
