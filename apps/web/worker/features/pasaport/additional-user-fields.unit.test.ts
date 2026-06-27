/**
 * The `input:false` invariant on better-auth's `user.additionalFields` — the
 * structural guard that makes every server-managed user column un-writable by a
 * client/session/registration payload. `tier` (the authorship tier, ADR 0107 §4)
 * is asserted alongside `role` (ADR 0098) and `username`: a fresh registration
 * cannot set or escalate any of them, so `tier` can never be born `yazar` from the
 * wire — it defaults to `çaylak` (the column default) and only the server path
 * promotes it. Testing the declared shape directly is how the `role` invariant is
 * verified — the field is the proof.
 */
import {describe, expect, it} from "vitest";
import {additionalUserFields} from "./better-auth-live.ts";

describe("additionalUserFields — every server-managed field is input:false", () => {
	for (const field of ["username", "role", "tier"] as const) {
		it(`${field} is declared input:false (no client write can set it)`, () => {
			expect(additionalUserFields[field].input).toBe(false);
		});

		it(`${field} is a string field`, () => {
			expect(additionalUserFields[field].type).toBe("string");
		});
	}

	it("exposes exactly the three server-managed fields", () => {
		expect(Object.keys(additionalUserFields).sort()).toEqual(["role", "tier", "username"]);
	});
});
