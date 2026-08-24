/**
 * The welcome arrival's decision contract (#7043, epic #4304), pinned without a DOM.
 * The load-bearing rows are the flag-off identity (criterion 1: the redirect is
 * byte-for-byte today's) and the gate order (`flag-dark-page-gate.md`).
 */
import {describe, expect, it} from "vitest";
import {
	postAuthDestination,
	WELCOME_PATH,
	welcomeAddressing,
	welcomeGate,
	welcomeReturnTo,
} from "./welcomeGating";

const READY_GATE = {
	flagOn: true,
	flagLoading: false,
	sessionPending: false,
	signedIn: true,
	welcomeSeen: false,
};

describe("postAuthDestination — the App.tsx intercept's decision", () => {
	it("flag off is byte-for-byte today's redirect, whatever the marker reads", () => {
		expect(postAuthDestination(false, false, "/pano")).toEqual({kind: "context", to: "/pano"});
		expect(postAuthDestination(false, true, "/pano")).toEqual({kind: "context", to: "/pano"});
		// The cold fallback target rides through untouched too.
		expect(postAuthDestination(false, false, "/")).toEqual({kind: "context", to: "/"});
	});

	it("flag on + never welcomed detours through the welcome surface carrying the target", () => {
		expect(postAuthDestination(true, false, "/pano")).toEqual({
			kind: "welcome",
			to: `${WELCOME_PATH}?returnTo=${encodeURIComponent("/pano")}`,
		});
	});

	it("the carried returnTo survives query strings and slashes via one encodeURIComponent", () => {
		const {to} = postAuthDestination(true, false, "/pano/yeni?sort=saved");
		expect(to).toBe(`${WELCOME_PATH}?returnTo=${encodeURIComponent("/pano/yeni?sort=saved")}`);
	});

	it("flag on + already welcomed goes straight to the context, as before", () => {
		expect(postAuthDestination(true, true, "/sozluk")).toEqual({kind: "context", to: "/sozluk"});
	});
});

describe("welcomeReturnTo — what the arrival hands back to", () => {
	it("passes a same-origin path through", () => {
		expect(welcomeReturnTo(`?returnTo=${encodeURIComponent("/pano")}`)).toBe("/pano");
	});

	it("falls back to / when the param is missing or off-site (safeReturnTo)", () => {
		expect(welcomeReturnTo("")).toBe("/");
		expect(welcomeReturnTo("?returnTo=https%3A%2F%2Fevil.example")).toBe("/");
		expect(welcomeReturnTo(`?returnTo=${encodeURIComponent("//evil.example")}`)).toBe("/");
	});
});

describe("welcomeGate — the page's render decision", () => {
	it("loading outranks everything while the flag or session resolves", () => {
		expect(welcomeGate({...READY_GATE, flagLoading: true})).toBe("loading");
		expect(welcomeGate({...READY_GATE, sessionPending: true})).toBe("loading");
	});

	it("a dark route 404s before any session question is asked", () => {
		expect(welcomeGate({...READY_GATE, flagOn: false, signedIn: false})).toBe("not-found");
	});

	it("a signed-out visitor is sent to auth, not 404'd", () => {
		expect(welcomeGate({...READY_GATE, signedIn: false})).toBe("sign-in");
	});

	it("an already-welcomed account is suppressed in favor of the returnTo", () => {
		expect(welcomeGate({...READY_GATE, welcomeSeen: true})).toBe("return");
		expect(welcomeGate(READY_GATE)).toBe("ready");
	});
});

describe("welcomeAddressing — who the screen may address by tier", () => {
	it("names the two real tiers and stays neutral otherwise", () => {
		expect(welcomeAddressing("çaylak")).toBe("çaylak");
		expect(welcomeAddressing("yazar")).toBe("yazar");
		expect(welcomeAddressing(null)).toBe("unknown");
		expect(welcomeAddressing(undefined)).toBe("unknown");
		expect(welcomeAddressing("visitor")).toBe("unknown");
	});
});
