/**
 * Round-trip (encode → decode) coverage for every message kind's payload/reply schema:
 * a decoded encoding must equal the original, proving each payload is a real
 * `effect/Schema` codec (acceptance criterion 2). Kinds with a typed reply also
 * round-trip their reply schema.
 */
import {assert, describe, it} from "@effect/vitest";
import {Schema} from "effect";
import {stampFromMillis} from "./instant.ts";
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
		});
		roundTrips(Messages.ClaimReply, {
			resource: "issue:3054",
			granted: false,
			collision: true,
			owner: "peer-b",
			since: stampFromMillis(Date.parse("2026-07-16T09:59:00Z")),
		});
	});

	it("kind 1b — release claim (fire-and-forget, no reply)", () => {
		roundTrips(Messages.ReleaseClaim, {
			resource: "issue:3054",
			claimant: "peer-a",
		});
	});

	it("kind 2 — drain-progress tally", () => {
		roundTrips(Messages.DrainProgressTally, {
			scope: "milestone:crew-mcp",
			completed: 3,
			inFlight: 2,
			total: 9,
			reporter: "peer-em",
		});
	});

	it("kind 3 — intake ping (with and without the optional note)", () => {
		roundTrips(Messages.IntakePing, {
			issue: asIssue(3100),
			from: "triage",
			note: "needs a second look",
		});
		roundTrips(Messages.IntakePing, {
			issue: asIssue(3100),
			from: "triage",
		});
	});

	it("kind 6 — engine nudge (pr and issue targets, with and without the optional note)", () => {
		roundTrips(Messages.EngineNudge, {
			target: {pr: asPr(3649)},
			from: "chief-of-staff",
			note: "reviewed + banked, worth a look",
		});
		roundTrips(Messages.EngineNudge, {
			target: {issue: asIssue(3100)},
			from: "chief-of-staff",
		});
	});

	it("kind 8 — nudge ack (both reference arms, with and without the optional note)", () => {
		roundTrips(Messages.NudgeAck, {
			inReplyTo: {_tag: "ResolvedNudge", target: {pr: asPr(3897)}},
			from: "engineering-manager",
			outcome: "already-done",
			note: "the enqueue was already in flight",
		});
		roundTrips(Messages.NudgeAck, {
			inReplyTo: {_tag: "UnknownNudge", reason: "the wake tag carried no decodable nudge"},
			from: "engineering-manager",
			outcome: "unknown",
		});
	});

	describe("kind 8 — NudgeAck is a reply, structurally not a nudge (#3956)", () => {
		const ack = {
			inReplyTo: {_tag: "ResolvedNudge", target: {issue: 3956}},
			from: "engineering-manager",
			outcome: "declined",
			note: "declined: the change contradicts a founder ruling",
		};
		const nudge = {target: {issue: 3956}, from: "chief-of-staff", note: "worth a look"};

		it("an ack does not decode as an EngineNudge", () => {
			assert.isTrue(Schema.decodeUnknownOption(Messages.EngineNudge)(ack)._tag === "None");
		});

		it("a nudge does not decode as a NudgeAck", () => {
			assert.isTrue(Schema.decodeUnknownOption(Messages.NudgeAck)(nudge)._tag === "None");
		});

		it("the disposition is a closed set — free-text prose is not an outcome", () => {
			assert.isTrue(
				Schema.decodeUnknownOption(Messages.NudgeAck)({...ack, outcome: "declined, here is why"})
					._tag === "None",
			);
			for (const outcome of ["already-done", "dispatched", "declined", "unknown"] as const) {
				assert.isTrue(
					Schema.decodeUnknownOption(Messages.NudgeAck)({...ack, outcome})._tag === "Some",
				);
			}
		});

		it("an ack must say what it answers — inReplyTo is required, never defaulted", () => {
			const {inReplyTo: _omitted, ...withoutReference} = ack;
			assert.isTrue(
				Schema.decodeUnknownOption(Messages.NudgeAck)(withoutReference)._tag === "None",
			);
		});

		it("the unknown arm carries NO target field to read a fabricated one out of", () => {
			const unknown = Messages.nudgeReferenceFor({not: "a nudge"});
			assert.strictEqual(unknown._tag, "UnknownNudge");
			assert.notProperty(unknown, "target");
		});

		it("nudgeReferenceFor resolves a real nudge to its own target, and nothing else (fail-closed)", () => {
			assert.deepStrictEqual(Messages.nudgeReferenceFor(nudge), {
				_tag: "ResolvedNudge",
				target: {issue: asIssue(3956)},
			});
			assert.deepStrictEqual(Messages.nudgeReferenceFor({target: {pr: 3897}, from: "cos"}), {
				_tag: "ResolvedNudge",
				target: {pr: asPr(3897)},
			});
			// nothing in hand, a wrong-shaped body, and another kind's body ALL resolve to the typed
			// unknown — never to a plausible-looking target guessed from context.
			for (const unresolvable of [undefined, null, {}, "EngineNudge", {issue: 3956, from: "x"}]) {
				assert.strictEqual(Messages.nudgeReferenceFor(unresolvable)._tag, "UnknownNudge");
			}
		});
	});

	it("kind 4 — presence announce + role lookup query/result", () => {
		roundTrips(Messages.PresenceAnnouncement, {
			peer: "peer-a",
			role: "builder",
		});
		roundTrips(Messages.RoleLookupQuery, {role: "builder"});
		roundTrips(Messages.RoleLookupResult, {
			role: "builder",
			peers: [
				{
					peer: "peer-a",
					role: "builder",
					lastSeen: stampFromMillis(Date.parse("2026-07-16T10:04:00Z")),
				},
				{
					peer: "peer-b",
					role: "builder",
					lastSeen: stampFromMillis(Date.parse("2026-07-16T10:04:30Z")),
				},
			],
		});
		roundTrips(Messages.RoleLookupResult, {role: "builder", peers: []});
	});

	it("kind 5 — heartbeat", () => {
		roundTrips(Messages.Heartbeat, {
			peer: "peer-a",
			ttlSeconds: 30,
		});
	});
});
