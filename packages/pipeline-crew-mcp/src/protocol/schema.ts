/**
 * protocol/schema — the Schema-typed payloads for every crew message kind.
 *
 * Generic (crew-agnostic); see the boundary note in `../index.ts`. The one non-obvious
 * thing: a role is a `RoleId` *parameter* (an opaque non-empty string), never a baked-in
 * crew noun — that is what lets tracker, peer, and edge code against this contract without
 * pulling in `crew/`. Every payload is an `effect/Schema` type so the wire format is
 * decode-checked at the boundary rather than trusted as an untyped bag.
 *
 * No payload here carries a sender-composed time. A sender on this substrate is a language model
 * composing JSON, so a time it supplies is authored prose, not a reading (#3895); the authoritative
 * instants are stamped by the transport (`peer/`'s envelope), the receiver (`peer/`'s inbox ack),
 * or the tracker (`since`/`lastSeen` below) as a `StampedInstant`. See ADR 0211.
 */
import {Option, Schema} from "effect";
import {StampedInstant} from "./instant.ts";

/** An opaque role identifier — a parameter, never a concrete crew role noun (see the module note). */
export const RoleId = Schema.NonEmptyString;

/** An opaque participant identifier — a peer/session on the substrate. */
export const PeerId = Schema.NonEmptyString;

/** An opaque message identifier, used to correlate an ack back to its delivery. */
export const MessageId = Schema.NonEmptyString;

/**
 * A GitHub issue number — a positive integer, branded so it can't be confused with a bare count
 * or an unrelated string. Modelled as a NUMBER, not a string: a number modelled as a bare string
 * is a discoverability footgun — the natural payload `{"issue": 3621}` was rejected `Expected
 * string, got 3621` with nothing surfacing the shape ahead of the send (#3622). `PrNumber` is the
 * sibling for a pull-request number; both are positive-int-branded so an issue number and a PR
 * number are nominally distinct (the union that carries them still keys pr-vs-issue, but the values
 * no longer interchange).
 */
export const IssueNumber = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1, {
		title: "IssueNumber",
		description: "a GitHub issue number (a positive integer)",
	}),
).pipe(Schema.brand("IssueNumber"));

/** A GitHub pull-request number — a positive integer, branded distinctly from an issue number (see `IssueNumber`, #3622). */
export const PrNumber = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1, {
		title: "PrNumber",
		description: "a GitHub pull-request number (a positive integer)",
	}),
).pipe(Schema.brand("PrNumber"));

// Kind 1 — synchronous claim / collision-check (request → typed reply).

/** A sender's request to claim a resource; answered by a `ClaimReply` (not fire-and-forget). */
export const ClaimRequest = Schema.Struct({
	resource: Schema.NonEmptyString,
	claimant: PeerId,
	role: RoleId,
});

/** The typed answer to a `ClaimRequest`: whether it was granted, and who currently owns it. */
export const ClaimReply = Schema.Struct({
	resource: Schema.NonEmptyString,
	granted: Schema.Boolean,
	collision: Schema.Boolean,
	owner: PeerId,
	/** Tracker-stamped from the tracker's own clock — never the claimant's word for when it claimed. */
	since: StampedInstant,
});

/**
 * A holder freeing its own resource claim (fire-and-forget). The `claimant` must be the claim's
 * holder — the tracker frees only a claim the caller holds, so steal-release is unrepresentable
 * (ADR 0191 facet 3). No reply: releasing is idempotent.
 */
export const ReleaseClaim = Schema.Struct({
	resource: Schema.NonEmptyString,
	claimant: PeerId,
});

// Kind 2 — drain-progress tally.

/**
 * A drain-progress report. `scope` names WHAT is being tallied and nothing else — it is telemetry
 * an aggregation reads, not a free-text side channel. Answering a nudge inside it (the "already
 * enqueued, no shipper re-fired" prose that shipped in a live `scope`, #3956) packs several
 * distinct facts into one string and makes the field unparseable; a nudge answer has its own typed
 * home, `NudgeAck` below.
 */
export const DrainProgressTally = Schema.Struct({
	scope: Schema.NonEmptyString,
	completed: Schema.Int,
	inFlight: Schema.Int,
	total: Schema.Int,
	reporter: PeerId,
});

// Kind 3 — intake ping.

export const IntakePing = Schema.Struct({
	issue: IssueNumber,
	from: RoleId,
	note: Schema.optionalKey(Schema.String),
});

// Kind 6 — engine nudge (advisory, non-routing; chief-of-staff → engine).

/**
 * The nudge's subject: exactly one of a PR or an issue, never both/neither — the `{pr|issue}`
 * shape modelled as a union so an ill-formed nudge that names both, or neither, is unrepresentable.
 */
export const NudgeTarget = Schema.Union([
	Schema.Struct({pr: PrNumber}),
	Schema.Struct({issue: IssueNumber}),
]);

/**
 * An advisory nudge about one specific PR/issue, IntakePing-shaped. It is NOT command authority
 * and NOT lane-assignment: an engine takes no code dependency on receiving one (the board stays the
 * authoritative pull-source), and a dropped/offline nudge is log-and-continue. See ADR 0189.
 */
export const EngineNudge = Schema.Struct({
	target: NudgeTarget,
	from: RoleId,
	note: Schema.optionalKey(Schema.String),
});

/**
 * The canonical tracker resource-key for a nudge target — the SINGLE definition of the
 * `NudgeTarget → claim-resource` convention (`pr-N` / `issue-N`). A claim writer (an engine
 * reserving its lane via `channel_claim`) and the claim-aware send path must key on the SAME
 * string for a claimed PR/issue to route to its holder, so this mapping has exactly one home
 * (the resource-key gap #3886 names). The `pr-`/`issue-` prefix keeps a PR and an issue of the
 * same number distinct in the shared claim keyspace, matching the branded `NudgeTarget` union.
 */
export const nudgeTargetResourceKey = (target: typeof NudgeTarget.Type): string =>
	"pr" in target ? `pr-${target.pr}` : `issue-${target.issue}`;

// Kind 8 — nudge ack (the typed answer to an advisory nudge; engine → chief-of-staff).

/**
 * The nudge a `NudgeAck` answers. `ResolvedNudge` names the nudge by the PR/issue it was about —
 * the only identity both ends share, since a nudge IS its target (`nudgeTargetResourceKey` above).
 * `UnknownNudge` carries a `reason` and NO target field at all, so there is no slot a consumer
 * could read a fabricated or defaulted reference out of: an ack whose subject could not be
 * resolved says so in the type rather than guessing a plausible number.
 */
export const NudgeReference = Schema.Union([
	Schema.Struct({_tag: Schema.Literal("ResolvedNudge"), target: NudgeTarget}),
	Schema.Struct({_tag: Schema.Literal("UnknownNudge"), reason: Schema.NonEmptyString}),
]);
export type NudgeReference = typeof NudgeReference.Type;

/**
 * What the answering peer DID about the nudge, as a closed set. Typed rather than free text
 * because the disposition is the load-bearing fact — an aggregation must be able to count
 * declines without parsing prose, which is exactly what a note-only answer prevented (#3956).
 * `unknown` is the honest fourth state (the peer cannot say), never a default to fall into.
 */
export const NudgeAckOutcome = Schema.Literals([
	"already-done",
	"dispatched",
	"declined",
	"unknown",
]);
export type NudgeAckOutcome = typeof NudgeAckOutcome.Type;

/**
 * The typed answer to an advisory `EngineNudge` — a REPLY, structurally not a nudge: `inReplyTo`
 * and `outcome` are required and `target` is absent, so a `NudgeAck` never decodes as an
 * `EngineNudge` and an `EngineNudge` never decodes as a `NudgeAck`. That mutual non-decodability
 * is the point: the defect this kind fixes is an engine answering a nudge by sending a *nudge*
 * back with its refusal as prose, leaving the kind saying "nudge" while the content said
 * "declined" (#3956).
 *
 * It joins the advisory-nudge class and inherits its semantics unchanged (ADR 0204): it is NOT
 * command authority, no peer may block on or gate anything on receiving one, and a dropped ack is
 * log-and-continue. The board stays the single authority for facts — an ack carries coordination
 * texture, never a fact a peer would otherwise read off the board.
 *
 * `note` is texture beside the typed outcome, never a routing channel and never the place the
 * disposition actually lives.
 */
export const NudgeAck = Schema.Struct({
	inReplyTo: NudgeReference,
	from: RoleId,
	outcome: NudgeAckOutcome,
	note: Schema.optionalKey(Schema.String),
});

/**
 * Resolve the delivered nudge a peer is answering into a `NudgeReference` — the fail-closed
 * producer, and the only sanctioned way to build one. A body that decodes as an `EngineNudge`
 * yields `ResolvedNudge` carrying that nudge's own target; ANY other input (a malformed body, a
 * different kind, nothing in hand) yields `UnknownNudge` naming why. It never falls back to a
 * caller-supplied or defaulted target, so an ack can misreport its subject only by being
 * explicitly unknown.
 */
export const nudgeReferenceFor = (deliveredNudgeBody: unknown): NudgeReference => {
	if (deliveredNudgeBody === undefined || deliveredNudgeBody === null) {
		return {_tag: "UnknownNudge", reason: "no delivered nudge was in hand to answer"};
	}
	return Option.match(Schema.decodeUnknownOption(EngineNudge)(deliveredNudgeBody), {
		onSome: (nudge): NudgeReference => ({_tag: "ResolvedNudge", target: nudge.target}),
		onNone: (): NudgeReference => ({
			_tag: "UnknownNudge",
			reason:
				"the message in hand does not decode as an EngineNudge, so its target is unresolvable",
		}),
	});
};

// Kind 4 — role discovery / presence (announce + lookup).

/** One presence record: a peer, the role it serves, and when it was last seen. */
export const PresenceEntry = Schema.Struct({
	peer: PeerId,
	role: RoleId,
	/** Tracker-stamped from the tracker's own clock — never the peer's word for when it was last up. */
	lastSeen: StampedInstant,
});

/**
 * A peer announcing its presence for a role (fire-and-forget). `attached` is the live-channel-half
 * bit (#3628): `true` (or absent, the back-compatible default) publishes a discoverable, serving
 * presence; `false` reserves a bare role slot that holds the crew cardinality claim but is NOT
 * returned by a lookup until the peer's inbox attaches and it re-announces attached.
 */
export const PresenceAnnouncement = Schema.Struct({
	peer: PeerId,
	role: RoleId,
	attached: Schema.optional(Schema.Boolean),
});

/** A lookup query for peers serving a role; answered by a `RoleLookupResult`. */
export const RoleLookupQuery = Schema.Struct({
	role: RoleId,
});

/** The typed answer to a `RoleLookupQuery`: the peers currently present for the role. */
export const RoleLookupResult = Schema.Struct({
	role: RoleId,
	peers: Schema.Array(PresenceEntry),
});

// Kind 5 — heartbeat (presence TTL keepalive).

export const Heartbeat = Schema.Struct({
	peer: PeerId,
	ttlSeconds: Schema.Int,
});

// Kind 7 — claim-holder lookup (the read side of the resource-claim keyspace, ADR 0191).

/** A lookup of the live holder of a resource claim; answered by a `LookupClaimResult`. */
export const LookupClaimQuery = Schema.Struct({
	resource: Schema.NonEmptyString,
});

/**
 * The typed answer to a `LookupClaimQuery`: the resource and — only when it carries a LIVE claim
 * (its holder's presence has not lapsed, ADR 0191 facet 2) — the holder's peer id. `holder` is an
 * EXACT-optional key: absent ⇒ unclaimed OR the holder's presence aged out. The claim-aware send
 * path collapses both absent cases to broadcast — there is no owning seat to route to.
 */
export const LookupClaimResult = Schema.Struct({
	resource: Schema.NonEmptyString,
	holder: Schema.optionalKey(PeerId),
});
