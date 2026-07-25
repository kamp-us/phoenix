/**
 * The crew catalog (AC 1): a total map from each standing role to its seams over `protocol/`,
 * covering the six required crew interactions, with the two `Claim`-based seams named apart.
 */
import {assert, describe, it} from "@effect/vitest";
import {NudgeAck} from "../protocol/index.ts";
import {ALL_SEAMS, CrewCatalogGroup, CrewSeams, crewCatalog} from "./catalog.ts";
import {CREW_ROLES} from "./roles.ts";

describe("crew/catalog — roles mapped to seams over protocol/", () => {
	it("maps every standing role (a total map, no missing entry)", () => {
		for (const role of CREW_ROLES) {
			const entry = crewCatalog.get(role);
			assert.isDefined(entry);
			assert.strictEqual(entry?.role, role);
			assert.deepStrictEqual([...(entry?.seams ?? [])], [...ALL_SEAMS]);
		}
		assert.strictEqual(crewCatalog.size, CREW_ROLES.length);
	});

	it("names the required crew seams over the protocol kinds", () => {
		// claim/collision-check, role-uniqueness lease, drain tally, intake ping,
		// role discovery/presence (announce + lookup) — the seams the ticket enumerates.
		for (const seam of [
			"claimCollisionCheck",
			"roleUniquenessLease",
			"drainTally",
			"intakePing",
			"engineNudge",
			"nudgeAck",
			"announcePresence",
			"lookupRole",
		] as const) {
			assert.isDefined(CrewSeams[seam]);
		}
	});

	it("names the two distinct crew uses of the one Claim kind apart", () => {
		// both ride Claim on the wire (resource vs role), so the catalog distinguishes them.
		assert.strictEqual(CrewSeams.claimCollisionCheck, CrewSeams.roleUniquenessLease);
	});

	it("exposes the crew catalog group as the full protocol catalog", () => {
		assert.deepStrictEqual([...CrewCatalogGroup.requests.keys()].sort(), [
			"AnnouncePresence",
			"Claim",
			"DrainProgress",
			"EngineNudge",
			"Heartbeat",
			"IntakePing",
			"LookupClaim",
			"LookupRole",
			"NudgeAck",
			"Release",
		]);
	});

	it("the nudge seam has a reply seam — an answer is its own seam, never a nudge sent backwards (#3956)", () => {
		assert.strictEqual(CrewSeams.nudgeAck, NudgeAck);
		// distinct wire kinds, not two names for one seam (as `claimCollisionCheck`/`roleUniquenessLease` are)
		assert.notStrictEqual(CrewSeams.nudgeAck._tag, CrewSeams.engineNudge._tag);
	});
});
