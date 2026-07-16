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

	it("kind 2 — planned-epic handoff (with and without the optional summary)", () => {
		roundTrips(Messages.EpicHandoffNotice, {
			epic: "epic:3045",
			child: "issue:3054",
			from: "em",
			to: "builder",
			summary: "protocol/ is the foundation edge codes against",
			at: "2026-07-16T10:01:00Z",
		});
		roundTrips(Messages.EpicHandoffNotice, {
			epic: "epic:3045",
			child: "issue:3054",
			from: "em",
			to: "builder",
			at: "2026-07-16T10:01:00Z",
		});
	});

	it("kind 3 — drain-progress tally", () => {
		roundTrips(Messages.DrainProgressTally, {
			scope: "milestone:crew-mcp",
			completed: 3,
			inFlight: 2,
			total: 9,
			reporter: "peer-em",
			at: "2026-07-16T10:02:00Z",
		});
	});

	it("kind 4 — intake ping (with and without the optional note)", () => {
		roundTrips(Messages.IntakePing, {
			issue: "issue:3100",
			from: "triage",
			note: "needs a second look",
			at: "2026-07-16T10:03:00Z",
		});
		roundTrips(Messages.IntakePing, {
			issue: "issue:3100",
			from: "triage",
			at: "2026-07-16T10:03:00Z",
		});
	});

	it("kind 5 — presence announce + role lookup query/result", () => {
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

	it("kind 6 — heartbeat", () => {
		roundTrips(Messages.Heartbeat, {
			peer: "peer-a",
			ttlSeconds: 30,
			at: "2026-07-16T10:05:00Z",
		});
	});

	it("kind 7 — inbox ack", () => {
		roundTrips(Messages.InboxAck, {
			messageId: "msg-1",
			by: "peer-b",
			at: "2026-07-16T10:06:00Z",
		});
	});
});
