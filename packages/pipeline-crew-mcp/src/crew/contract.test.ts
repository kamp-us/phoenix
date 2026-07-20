/**
 * The crew composition of the discoverable channel contract (#3622): each role's sanctioned seams
 * (read off the catalog, so a future non-flat topology stays in sync) joined with the generic
 * kind→shape map, and the whole thing resolved as the startup invariant.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {crewMessageKinds} from "../protocol/index.ts";
import {ALL_SEAMS} from "./catalog.ts";
import {resolveChannelContract, roleContract, roleContracts} from "./contract.ts";
import {CREW_ROLES} from "./roles.ts";

describe("crew/contract — the discoverable role↔kind surface (#3622)", () => {
	it("resolves each role's seams to the wire kinds they ride, off the catalog", () => {
		const contract = roleContract("engineering-manager");
		assert.strictEqual(contract.role, "engineering-manager");
		const byName = new Map(contract.seams.map((s) => [s.seam, s.kind]));
		// the seam→kind mapping a peer resolves: which wire kind each named seam actually carries.
		assert.strictEqual(byName.get("intakePing"), "IntakePing");
		assert.strictEqual(byName.get("claimCollisionCheck"), "Claim");
		assert.strictEqual(byName.get("engineNudge"), "EngineNudge");
	});

	it("gives every role the full seam set under the flat topology (sourced from the catalog)", () => {
		for (const role of CREW_ROLES) {
			const seams = roleContract(role).seams.map((s) => s.seam);
			assert.deepStrictEqual([...seams], [...ALL_SEAMS]);
		}
		assert.strictEqual(roleContracts().length, CREW_ROLES.length);
	});

	it.effect("resolveChannelContract yields the full kind set + every role, or fails at boot", () =>
		Effect.gen(function* () {
			const contract = yield* resolveChannelContract();
			assert.deepStrictEqual(
				contract.kinds.map((k) => k.kind).sort(),
				[...crewMessageKinds].sort(),
			);
			assert.deepStrictEqual(
				contract.roles.map((r) => r.role),
				[...CREW_ROLES],
			);
			// the footgun fix is visible in the resolved contract: IntakePing.issue is an integer shape.
			const ping = contract.kinds.find((k) => k.kind === "IntakePing");
			const issue = (ping?.payload.schema as {properties?: {issue?: {type?: string}}}).properties
				?.issue;
			assert.strictEqual(issue?.type, "integer");
		}),
	);
});
