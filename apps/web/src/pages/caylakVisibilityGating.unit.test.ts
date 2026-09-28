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
	it("holds at loading while the session resolves", () => {
		expect(caylakVisibilityGate({...on, sessionPending: true, signedIn: false})).toBe("loading");
	});

	it("404s with the flag off, signed in or not", () => {
		expect(caylakVisibilityGate({...on, flagOn: false})).toBe("not-found");
		expect(caylakVisibilityGate({...on, flagOn: false, signedIn: false})).toBe("not-found");
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
