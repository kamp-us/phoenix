/**
 * crew/roles — the kind-typed roster seam (ADR 0189): the roster is three bridges + the engine
 * pool, cardinality falls out of the KIND, and a role still decode-checks at the wire boundary.
 * These tests pin the confirmed roster + the kind/cardinality derivation so a stale roster or a
 * mis-kinded role can't slip through.
 */
import {assert, describe, it} from "@effect/vitest";
import {Schema} from "effect";
import {
	CREW_ROLES,
	CREW_ROSTER,
	CrewRole,
	cardinalityOf,
	cardinalityOfKind,
	isCrewRole,
	kindOf,
} from "./roles.ts";

describe("crew/roles — the kind-typed roster (ADR 0189)", () => {
	it("is exactly the confirmed roster: three bridges + the engine", () => {
		assert.deepStrictEqual(CREW_ROSTER, {
			"chief-of-staff": "bridge",
			cartographer: "bridge",
			"intake-desk": "bridge",
			"engineering-manager": "engine",
		});
	});

	it("dropped junior-engineer and the old ea-chief-of-staff / triage-guy slugs", () => {
		const slugs = new Set<string>(CREW_ROLES);
		assert.isFalse(slugs.has("junior-engineer"));
		assert.isFalse(slugs.has("ea-chief-of-staff"));
		assert.isFalse(slugs.has("triage-guy"));
		assert.strictEqual(slugs.size, 4);
	});

	it("CREW_ROLES enumerates exactly the roster keys", () => {
		assert.deepStrictEqual(new Set(CREW_ROLES), new Set(Object.keys(CREW_ROSTER)));
	});

	it("decodes a member and rejects a non-role", () => {
		for (const role of CREW_ROLES) {
			assert.strictEqual(Schema.decodeUnknownSync(CrewRole)(role), role);
			assert.isTrue(isCrewRole(role));
		}
		assert.isFalse(isCrewRole("junior-engineer"));
		assert.isFalse(isCrewRole("triage-guy"));
		assert.isFalse(isCrewRole("reviewer"));
	});

	it("kindOf is total and kinds every role bridge/engine per the roster", () => {
		for (const role of CREW_ROLES) {
			assert.strictEqual(kindOf(role), CREW_ROSTER[role]);
		}
		assert.strictEqual(kindOf("chief-of-staff"), "bridge");
		assert.strictEqual(kindOf("cartographer"), "bridge");
		assert.strictEqual(kindOf("intake-desk"), "bridge");
		assert.strictEqual(kindOf("engineering-manager"), "engine");
	});

	it("derives cardinality from the kind: bridge → 1, engine → N", () => {
		assert.strictEqual(cardinalityOfKind("bridge"), 1);
		assert.strictEqual(cardinalityOfKind("engine"), "N");
		assert.strictEqual(cardinalityOf("chief-of-staff"), 1);
		assert.strictEqual(cardinalityOf("engineering-manager"), "N");
		for (const role of CREW_ROLES) {
			assert.strictEqual(cardinalityOf(role), kindOf(role) === "bridge" ? 1 : "N");
		}
	});

	it("a bridge cardinality is the literal 1 at the type level (2 is unrepresentable)", () => {
		// The compile-time face of the invariant: cardinalityOfKind("bridge") is typed exactly `1`,
		// so a bridge-with-cardinality-2 does not typecheck. This `satisfies 1` is the assertion.
		const bridgeCardinality = cardinalityOfKind("bridge") satisfies 1;
		assert.strictEqual(bridgeCardinality, 1);
	});
});
