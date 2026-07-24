/**
 * Pins `signUpDisposition` of `_harness.ts`: the two 422 sign-up shapes must stay
 * distinguishable so `signUp` replays only the TRANSIENT cold-D1 user-creation failure
 * (`FAILED_TO_CREATE_USER`, #3799) while still routing the semantic duplicate
 * (`USER_ALREADY_EXISTS`) to sign-in and surfacing every real client error (#3799).
 */

import {describe, expect, it} from "vitest";
import {signUpDisposition} from "./_harness.ts";

describe("signUpDisposition", () => {
	it("routes a 422 USER_ALREADY_EXISTS to the sign-in fallback", () => {
		expect(
			signUpDisposition(422, JSON.stringify({message: "…", code: "USER_ALREADY_EXISTS"})),
		).toBe("exists");
	});

	it("replays a 422 FAILED_TO_CREATE_USER as transient (the #3799 cold-D1 signature)", () => {
		expect(
			signUpDisposition(422, '{"message":"Failed to create user","code":"FAILED_TO_CREATE_USER"}'),
		).toBe("transient");
	});

	it.each([
		[422, JSON.stringify({code: "INVALID_EMAIL"}), "a different 422 validation code"],
		[
			400,
			JSON.stringify({code: "FAILED_TO_CREATE_USER"}),
			"the transient code on a non-422 status",
		],
		[401, "unauthorized", "a 401"],
		[500, "boom", "a 5xx body handled by postIdempotent, not here"],
	])("treats %s (%s) as terminal", (status, body) => {
		expect(signUpDisposition(status as number, body as string)).toBe("terminal");
	});
});
