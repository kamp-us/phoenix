/**
 * The landing page's auth-gating contract (#1784) — the pure CTA-phase decision
 * asserted without a DOM (the pure-extraction idiom of `divanGating`; `apps/web/src`
 * has no jsdom). These are the AC the fix lives or dies on: a signed-in user never
 * sees the `hesap aç →` join CTA, an anonymous viewer still does, and the CTA never
 * flashes in/out while auth is resolving (#448).
 */
import {describe, expect, it} from "vitest";
import {landingCtaPhase, showJoinCta} from "./landingGating";

describe("landingCtaPhase — the three-valued auth phase", () => {
	it("is `resolving` while the session is pending, regardless of me status", () => {
		// #448: session starts {data:null, isPending:true} — must not read as anonymous.
		expect(landingCtaPhase(true, "idle")).toBe("resolving");
		expect(landingCtaPhase(true, "loading")).toBe("resolving");
		expect(landingCtaPhase(true, "ok")).toBe("resolving");
		expect(landingCtaPhase(true, "error")).toBe("resolving");
	});

	it("is `anonymous` once the session resolved with no user (me idle)", () => {
		expect(landingCtaPhase(false, "idle")).toBe("anonymous");
	});

	it("is `signedIn` once the session resolved to a user and me loaded (ok)", () => {
		expect(landingCtaPhase(false, "ok")).toBe("signedIn");
	});

	it("is `resolving` for a signed-in session whose me is still loading — no flash back to the CTA", () => {
		// A session-update refetch (e.g. after setUsername) re-enters `loading`; the
		// CTA must stay hidden, not flash the join prompt back in.
		expect(landingCtaPhase(false, "loading")).toBe("resolving");
	});

	it("is `resolving` (not anonymous) when an established session's me read errors", () => {
		// A failed row read must not flash a "create account" prompt at a signed-in user.
		expect(landingCtaPhase(false, "error")).toBe("resolving");
	});
});

describe("showJoinCta — the CTA + rite framing visibility", () => {
	it("shows the join CTA only to an anonymous viewer", () => {
		expect(showJoinCta("anonymous")).toBe(true);
	});

	it("hides the join CTA from a signed-in user (the #1784 defect)", () => {
		expect(showJoinCta("signedIn")).toBe(false);
	});

	it("hides the join CTA while auth is resolving (no flash — #448)", () => {
		expect(showJoinCta("resolving")).toBe(false);
	});
});
