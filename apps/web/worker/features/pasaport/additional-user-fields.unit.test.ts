/**
 * The `input:false` invariant on better-auth's `user.additionalFields` — the
 * structural guard that keeps every server-managed user column un-writable from a
 * client/session/registration payload. Without it a fresh registration could be born
 * `yazar` or `moderator` straight off the wire. The declared field IS the proof.
 */
import {describe, expect, it} from "vitest";
import {additionalUserFields} from "./better-auth-live.ts";

describe("additionalUserFields — every server-managed field is input:false", () => {
	// Iterates the declaration itself, so a field added later is covered the moment it lands.
	for (const [field, config] of Object.entries(additionalUserFields)) {
		it(`${field} is declared input:false (no client write can set it)`, () => {
			expect(config.input).toBe(false);
		});
	}

	it("promotedAt is returned:false (the value is not surfaced to the client)", () => {
		expect(additionalUserFields.promotedAt.returned).toBe(false);
	});
});
