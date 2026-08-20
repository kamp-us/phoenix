import {describe, expect, it} from "vitest";
import {type CaylakVisibilityGateInput, caylakVisibilityGate} from "./caylakVisibilityGating";

const on: CaylakVisibilityGateInput = {
	flagOn: true,
	flagLoading: false,
	sessionPending: false,
	signedIn: true,
	tier: "yazar",
	meFailed: false,
};

describe("caylakVisibilityGate (#6426)", () => {
	it("gives a signed-in yazar the toggle", () => {
		expect(caylakVisibilityGate(on)).toBe("toggle");
	});

	it("holds at loading while the flag resolves, even with the flag's off default in hand", () => {
		// The 404 must not flash: an unresolved flag reads `false`, and answering `not-found`
		// there is exactly the flash this ordering exists to prevent.
		expect(caylakVisibilityGate({...on, flagLoading: true, flagOn: false})).toBe("loading");
	});

	it("holds at loading while the session resolves", () => {
		expect(caylakVisibilityGate({...on, sessionPending: true, signedIn: false})).toBe("loading");
	});

	it("404s with the flag off, signed in or not", () => {
		expect(caylakVisibilityGate({...on, flagOn: false})).toBe("not-found");
		expect(caylakVisibilityGate({...on, flagOn: false, signedIn: false})).toBe("not-found");
	});

	it("sends a signed-out visitor to auth once the flag is on", () => {
		expect(caylakVisibilityGate({...on, signedIn: false, tier: null})).toBe("sign-in");
	});

	it("shows the çaylak explanation instead of a control", () => {
		expect(caylakVisibilityGate({...on, tier: "çaylak"})).toBe("caylak");
	});

	it("treats an unread tier as loading, never as çaylak", () => {
		// A yazar whose `me` read has not landed would otherwise be told they are a çaylak.
		expect(caylakVisibilityGate({...on, tier: null})).toBe("loading");
		expect(caylakVisibilityGate({...on, tier: undefined})).toBe("loading");
	});

	it("says so honestly when the tier read failed", () => {
		expect(caylakVisibilityGate({...on, meFailed: true, tier: null})).toBe("unavailable");
	});
});
