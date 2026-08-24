import {describe, expect, it} from "vitest";
import {landingCtaPhase, showJoinCta, showSignedInRite} from "./landingGating";

describe("landingCtaPhase — the three-valued auth phase", () => {
	it("is `resolving` while the session is pending, regardless of me status or tier", () => {
		expect(landingCtaPhase(true, "idle", undefined)).toBe("resolving");
		expect(landingCtaPhase(true, "loading", "çaylak")).toBe("resolving");
		expect(landingCtaPhase(true, "ok", "yazar")).toBe("resolving");
		expect(landingCtaPhase(true, "error", undefined)).toBe("resolving");
	});

	it("is `anonymous` once the session resolved with no user (me idle)", () => {
		expect(landingCtaPhase(false, "idle", undefined)).toBe("anonymous");
	});

	it("is `signedIn` once a non-çaylak user's me loaded (ok)", () => {
		expect(landingCtaPhase(false, "ok", "yazar")).toBe("signedIn");
	});

	it("is `signedInCaylak` for a signed-in çaylak (#7046)", () => {
		expect(landingCtaPhase(false, "ok", "çaylak")).toBe("signedInCaylak");
	});

	it("reads a loaded me with no tier as the quiet signed-in landing (fail closed)", () => {
		expect(landingCtaPhase(false, "ok", undefined)).toBe("signedIn");
	});

	it("is `resolving` for a signed-in session whose me is still loading — no flash back to the CTA", () => {
		expect(landingCtaPhase(false, "loading", "çaylak")).toBe("resolving");
	});

	it("is `resolving` (not anonymous) when an established session's me read errors", () => {
		expect(landingCtaPhase(false, "error", undefined)).toBe("resolving");
	});
});

describe("showJoinCta — the CTA + rite framing visibility", () => {
	it("shows the join CTA only to an anonymous viewer", () => {
		expect(showJoinCta("anonymous")).toBe(true);
	});

	it("hides the join CTA from any signed-in reading, çaylak included (the #1784 defect)", () => {
		expect(showJoinCta("signedIn")).toBe(false);
		expect(showJoinCta("signedInCaylak")).toBe(false);
	});

	it("hides the join CTA while auth is resolving (no flash — #448)", () => {
		expect(showJoinCta("resolving")).toBe(false);
	});
});

describe("showSignedInRite — the signed-in-çaylak explainer visibility (#7046)", () => {
	it("shows the explainer only to a signed-in çaylak", () => {
		expect(showSignedInRite("signedInCaylak")).toBe(true);
		expect(showSignedInRite("anonymous")).toBe(false);
		expect(showSignedInRite("signedIn")).toBe(false);
		expect(showSignedInRite("resolving")).toBe(false);
	});
});
