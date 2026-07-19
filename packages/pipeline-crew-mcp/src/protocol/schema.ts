/**
 * protocol/schema — the Schema-typed payloads for every crew message kind.
 *
 * Generic (crew-agnostic); see the boundary note in `../index.ts`. The one non-obvious
 * thing: a role is a `RoleId` *parameter* (an opaque non-empty string), never a baked-in
 * crew noun — that is what lets tracker, peer, and edge code against this contract without
 * pulling in `crew/`. Every payload is an `effect/Schema` type so the wire format is
 * decode-checked at the boundary rather than trusted as an untyped bag.
 */
import {Schema} from "effect";

/** An opaque role identifier — a parameter, never a concrete crew role noun (see the module note). */
export const RoleId = Schema.NonEmptyString;

/** An opaque participant identifier — a peer/session on the substrate. */
export const PeerId = Schema.NonEmptyString;

/** An opaque message identifier, used to correlate an ack back to its delivery. */
export const MessageId = Schema.NonEmptyString;

/** An ISO-8601 UTC instant, kept as a string so the wire format stays transport-agnostic + JSON-safe. */
export const Timestamp = Schema.String;

// Kind 1 — synchronous claim / collision-check (request → typed reply).

/** A sender's request to claim a resource; answered by a `ClaimReply` (not fire-and-forget). */
export const ClaimRequest = Schema.Struct({
	resource: Schema.NonEmptyString,
	claimant: PeerId,
	role: RoleId,
	at: Timestamp,
});

/** The typed answer to a `ClaimRequest`: whether it was granted, and who currently owns it. */
export const ClaimReply = Schema.Struct({
	resource: Schema.NonEmptyString,
	granted: Schema.Boolean,
	collision: Schema.Boolean,
	owner: PeerId,
	since: Timestamp,
});

/**
 * A holder freeing its own resource claim (fire-and-forget). The `claimant` must be the claim's
 * holder — the tracker frees only a claim the caller holds, so steal-release is unrepresentable
 * (ADR 0191 facet 3). No reply: releasing is idempotent.
 */
export const ReleaseClaim = Schema.Struct({
	resource: Schema.NonEmptyString,
	claimant: PeerId,
	at: Timestamp,
});

// Kind 2 — drain-progress tally.

export const DrainProgressTally = Schema.Struct({
	scope: Schema.NonEmptyString,
	completed: Schema.Int,
	inFlight: Schema.Int,
	total: Schema.Int,
	reporter: PeerId,
	at: Timestamp,
});

// Kind 3 — intake ping.

export const IntakePing = Schema.Struct({
	issue: Schema.NonEmptyString,
	from: RoleId,
	note: Schema.optionalKey(Schema.String),
	at: Timestamp,
});

// Kind 6 — engine nudge (advisory, non-routing; chief-of-staff → engine).

/**
 * The nudge's subject: exactly one of a PR or an issue, never both/neither — the `{pr|issue}`
 * shape modelled as a union so an ill-formed nudge that names both, or neither, is unrepresentable.
 */
export const NudgeTarget = Schema.Union([
	Schema.Struct({pr: Schema.NonEmptyString}),
	Schema.Struct({issue: Schema.NonEmptyString}),
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
	at: Timestamp,
});

// Kind 4 — role discovery / presence (announce + lookup).

/** One presence record: a peer, the role it serves, and when it was last seen. */
export const PresenceEntry = Schema.Struct({
	peer: PeerId,
	role: RoleId,
	lastSeen: Timestamp,
});

/** A peer announcing that it serves a role (fire-and-forget). */
export const PresenceAnnouncement = Schema.Struct({
	peer: PeerId,
	role: RoleId,
	at: Timestamp,
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
	at: Timestamp,
});
