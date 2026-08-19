/**
 * The `input:false` invariant on better-auth's `user.additionalFields` — the
 * structural guard that keeps every server-managed user column un-writable from a
 * client/session/registration payload. Without it a fresh registration could be born
 * `yazar` or `moderator` straight off the wire. The declared field IS the proof.
 */
import {describe, expect, it} from "vitest";
import {additionalUserFields} from "./better-auth-live.ts";

describe("additionalUserFields — every server-managed field is input:false", () => {
	for (const field of ["username", "role", "tier", "promotedAt"] as const) {
		it(`${field} is declared input:false (no client write can set it)`, () => {
			expect(additionalUserFields[field].input).toBe(false);
		});
	}

	for (const field of ["username", "role", "tier"] as const) {
		it(`${field} is a string field`, () => {
			expect(additionalUserFields[field].type).toBe("string");
		});
	}

	it("promotedAt is a date field", () => {
		expect(additionalUserFields.promotedAt.type).toBe("date");
	});

	it("promotedAt is returned:false (the value is not surfaced to the client)", () => {
		expect(additionalUserFields.promotedAt.returned).toBe(false);
	});

	it("exposes exactly the four server-managed fields", () => {
		expect(Object.keys(additionalUserFields).sort()).toEqual([
			"promotedAt",
			"role",
			"tier",
			"username",
		]);
	});
});
