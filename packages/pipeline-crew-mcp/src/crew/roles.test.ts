/**
 * The Role enum (AC 1): the five standing crew roles, the canonical agent-type slugs, and
 * that the enum decode-checks a role (accepts a member, rejects a non-role). The roster is a
 * single seam — this test pins the confirmed set so a stale/short list can't slip through.
 */
import {assert, describe, it} from "@effect/vitest";
import {Schema} from "effect";
import {CREW_ROLES, CrewRole, isCrewRole} from "./roles.ts";

describe("crew/roles — the five standing roles", () => {
	it("is exactly the confirmed five-role roster", () => {
		assert.deepStrictEqual(
			[...CREW_ROLES],
			["ea-chief-of-staff", "engineering-manager", "triage-guy", "junior-engineer", "cartographer"],
		);
	});

	it("has five distinct roles (no duplicate slug)", () => {
		assert.strictEqual(new Set(CREW_ROLES).size, 5);
	});

	it("decodes a member and rejects a non-role", () => {
		for (const role of CREW_ROLES) {
			assert.strictEqual(Schema.decodeUnknownSync(CrewRole)(role), role);
			assert.isTrue(isCrewRole(role));
		}
		assert.isFalse(isCrewRole("reviewer"));
		assert.isFalse(isCrewRole("builder"));
	});
});
