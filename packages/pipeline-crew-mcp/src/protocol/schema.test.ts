/**
 * Round-trip (encode → decode) coverage for every message kind's payload/reply schema:
 * a decoded encoding must equal the original, proving each payload is a real
 * `effect/Schema` codec (acceptance criterion 2). Kinds with a typed reply also
 * round-trip their reply schema.
 */
import {assert, describe, it} from "@effect/vitest";
import {Schema} from "effect";
import * as Messages from "./schema.ts";

const roundTrips = <S extends Schema.Codec<any, any>>(schema: S, value: S["Type"]): void => {
	const encoded = Schema.encodeSync(schema)(value);
	const decoded = Schema.decodeUnknownSync(schema)(encoded);
	assert.deepStrictEqual(decoded, value);
};

// Construct branded issue/PR numbers (a bare literal can't satisfy `number & Brand`), the natural
// NUMBER shape the footgun fix mandates (#3622).
const asIssue = Schema.decodeUnknownSync(Messages.IssueNumber);
const asPr = Schema.decodeUnknownSync(Messages.PrNumber);

describe("protocol/schema round-trips", () => {
	it("kind 1 — claim request + reply", () => {
		roundTrips(Messages.ClaimRequest, {
			resource: "issue:3054",
			claimant: "peer-a",
			role: "builder",
			at: "2026-07-16T10:00:00Z",
		});
		roundTrips(Messages.ClaimReply, {
			resource: "issue:3054",
			granted: false,
			collision: true,
			owner: "peer-b",
			since: "2026-07-16T09:59:00Z",
		});
	});

	it("kind 1b — release claim (fire-and-forget, no reply)", () => {
		roundTrips(Messages.ReleaseClaim, {
			resource: "issue:3054",
			claimant: "peer-a",
			at: "2026-07-16T10:05:00Z",
		});
	});

	it("kind 2 — drain-progress tally", () => {
		roundTrips(Messages.DrainProgressTally, {
			scope: "milestone:crew-mcp",
			completed: 3,
			inFlight: 2,
			total: 9,
			reporter: "peer-em",
			at: "2026-07-16T10:02:00Z",
		});
	});

	it("kind 3 — intake ping (with and without the optional note)", () => {
		roundTrips(Messages.IntakePing, {
			issue: asIssue(3100),
			from: "triage",
			note: "needs a second look",
			at: "2026-07-16T10:03:00Z",
		});
		roundTrips(Messages.IntakePing, {
			issue: asIssue(3100),
			from: "triage",
			at: "2026-07-16T10:03:00Z",
		});
	});

	it("kind 6 — engine nudge (pr and issue targets, with and without the optional note)", () => {
		roundTrips(Messages.EngineNudge, {
			target: {pr: asPr(3649)},
			from: "chief-of-staff",
			note: "reviewed + banked, worth a look",
			at: "2026-07-19T10:03:00Z",
		});
		roundTrips(Messages.EngineNudge, {
			target: {issue: asIssue(3100)},
			from: "chief-of-staff",
			at: "2026-07-19T10:03:00Z",
		});
	});

	it("kind 4 — presence announce + role lookup query/result", () => {
		roundTrips(Messages.PresenceAnnouncement, {
			peer: "peer-a",
			role: "builder",
			at: "2026-07-16T10:04:00Z",
		});
		roundTrips(Messages.RoleLookupQuery, {role: "builder"});
		roundTrips(Messages.RoleLookupResult, {
			role: "builder",
			peers: [
				{peer: "peer-a", role: "builder", lastSeen: "2026-07-16T10:04:00Z"},
				{peer: "peer-b", role: "builder", lastSeen: "2026-07-16T10:04:30Z"},
			],
		});
		roundTrips(Messages.RoleLookupResult, {role: "builder", peers: []});
	});

	it("kind 5 — heartbeat", () => {
		roundTrips(Messages.Heartbeat, {
			peer: "peer-a",
			ttlSeconds: 30,
			at: "2026-07-16T10:05:00Z",
		});
	});
});
