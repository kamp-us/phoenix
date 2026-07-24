/**
 * peer/peer — the session-edge peer: an `RpcServer` inbox + an `RpcClient` dialer that
 * announces to the tracker and sends peer-to-peer. Generic (crew-agnostic); see the
 * boundary note in `../index.ts`.
 *
 * `make` reserves this peer's role slot as a BARE lease (holds the slot + backs the crew
 * cardinality claim + connection-is-lease, #3035) but does NOT make it discoverable. Becoming a
 * live peer is a separate `announce` step the caller runs once its inbox is attached and serving,
 * so presence reflects a live channel half, not mere construction (#3628). `send` looks the target
 * role up via the tracker (the tracker never relays) and delivers to live holders' inboxes directly —
 * one holder for a singleton bridge, every seat for an engine pool, so a per-item advisory reaches the
 * seat that owns the item rather than only the head (#3770). Delivery is claim-aware: a send that names
 * a claimed resource (`options.claimResource`) routes to the CLAIM HOLDER's seat only, sparing the
 * non-owning seats (#3886); an unclaimed/unresolvable target keeps the broadcast fan across all holders.
 * A send to a role with NO live peer surfaces as `PeerUnreachableError`; a send whose recipients are all present but
 * deaf surfaces as a distinguishable `ChannelDeafError`, fast — never a silent drop, never a hang.
 */

import {randomUUID} from "node:crypto";
import {Duration, Effect, Option, Result, type Scope} from "effect";
import * as Arr from "effect/Array";
import {Dialer} from "./dialer.ts";
import {ChannelDeafError, PeerUnreachableError} from "./errors.ts";
import {Inbox, type InboxAck, type InboxEnvelope} from "./inbox.ts";
import {type RolePresence, Tracker} from "./tracker.ts";

/**
 * Narrow a role's live holder set to the delivery target(s) for one send. With no claim owner
 * (`None` ⇒ the resource is unclaimed, its holder's presence lapsed, or the message named no
 * claimable resource), the whole live pool receives the message — the pre-claim-aware broadcast
 * fan (#3770). With a claim owner that IS a live holder of the role, delivery narrows to that ONE
 * seat — the claim-aware route (#3886). A claim owner that is NOT among the live holders (a rare
 * presence/attachment skew) falls back to the full fan rather than dialing a seat the role lookup
 * did not surface. The result is therefore always a NON-EMPTY subset of `holders`: claim-aware
 * routing only ever narrows the fan, never widens it or empties it.
 */
export const selectDeliveryTargets = (
	holders: Arr.NonEmptyReadonlyArray<RolePresence>,
	claimOwnerAddress: Option.Option<string>,
): Arr.NonEmptyReadonlyArray<RolePresence> =>
	Option.match(claimOwnerAddress, {
		onNone: () => holders,
		onSome: (address) => {
			const owned = Arr.filter(holders, (h) => h.address === address);
			return Arr.isReadonlyArrayNonEmpty(owned) ? owned : holders;
		},
	});

/**
 * The bounded dial window: a present peer whose inbox does not answer within it fails fast as
 * channel-deaf rather than hanging (#3628 AC3). It sits well above a healthy socket round-trip, so it
 * only ever bounds a genuinely-stuck dial — a dead or orphaned unix socket refuses far sooner
 * (`ECONNREFUSED`), which is already mapped to channel-deaf below.
 */
const DIAL_TIMEOUT = Duration.seconds(5);

export interface PeerConfig {
	/** This peer's opaque id. */
	readonly self: string;
	/** The opaque role this peer serves (a parameter, never a baked-in crew noun). */
	readonly role: string;
	/** This peer's dialable inbox address, announced to the tracker for others to reach. */
	readonly address: string;
}

export interface Peer {
	readonly self: string;
	readonly role: string;
	readonly address: string;
	/** What this peer's inbox has received. */
	readonly received: Effect.Effect<ReadonlyArray<InboxEnvelope>>;
	/**
	 * Flip this peer to a discoverable, ATTACHED presence, held for the enclosing scope. `make` already
	 * reserved the bare role slot; the caller runs THIS only once its inbox is attached and serving, so
	 * a session whose inbox never attaches never becomes discoverable via `LookupRole` (#3628).
	 */
	readonly announce: Effect.Effect<void, never, Scope.Scope>;
	/**
	 * Send a typed message to `targetRole`; resolves to a delivery-receipt inbox-ack (delivered iff
	 * at least one recipient acked). Delivery is claim-aware: pass `options.claimResource` (an OPAQUE
	 * tracker resource key — the crew maps a `NudgeTarget` to `pr-N`/`issue-N`) and, when that
	 * resource has a live claim whose holder is a live holder of the role, the message routes to that
	 * ONE seat (#3886); otherwise — no key, unclaimed, lapsed, or holder-not-present — it fans to
	 * EVERY live holder (the broadcast, #3770). A role with no live peer fails with
	 * `PeerUnreachableError`; a role whose recipients are all present but deaf fails with a
	 * distinguishable `ChannelDeafError`, fast.
	 */
	readonly send: (
		targetRole: string,
		kind: string,
		body: unknown,
		options?: SendOptions,
	) => Effect.Effect<InboxAck, PeerUnreachableError | ChannelDeafError>;
}

/** Per-send delivery options. `claimResource` opts one send into claim-aware routing (see `send`). */
export interface SendOptions {
	/**
	 * The OPAQUE tracker resource key this message routes by. When set and the resource carries a
	 * live claim held by a live holder of the target role, delivery narrows to that holder's seat;
	 * absent or unresolvable ⇒ the broadcast fan. The peer never derives this key (it holds no
	 * message semantics) — the caller supplies it (the crew's `Protocol.claimResourceKey`).
	 */
	readonly claimResource?: string;
}

export const make = Effect.fn("Peer.make")(function* (config: PeerConfig) {
	const inbox = yield* Inbox;
	const tracker = yield* Tracker;
	const dialer = yield* Dialer;

	const presence = {role: config.role, peer: config.self, address: config.address};
	// Reserve the bare role slot on construction — it holds the crew cardinality claim + the
	// connection-is-lease slot for this scope, but is NOT discoverable until `announce` attaches it (#3628).
	yield* tracker.reserve(presence);
	// The attach flip: publish a discoverable, serving presence. Exposed for the caller to run once its
	// inbox socket server is bound and serving, so a channel-deaf session never becomes a live peer.
	const announce = tracker.announce(presence);

	// Dial ONE holder's inbox: the tracker returned a live lease, so a dial that won't complete is
	// channel-deaf — presence reflected a stale socket file, not a live inbox (#3628). Fold BOTH a
	// fast dial refusal (a dead/orphaned socket → PeerUnreachableError) and a genuine hang (the
	// bounded timeout) into one distinguishable ChannelDeafError, so a caller tells "registered but
	// deaf" from "nobody there". Reused per-holder by the fan below.
	const dialHolder = (targetRole: string, address: string, envelope: InboxEnvelope) =>
		dialer.send(address, envelope).pipe(
			Effect.timeoutOrElse({
				duration: DIAL_TIMEOUT,
				orElse: () =>
					Effect.fail(
						new ChannelDeafError({
							target: targetRole,
							address,
							reason: "the inbox did not answer within the dial timeout",
						}),
					),
			}),
			Effect.catchTag("@kampus/pipeline-crew-mcp/PeerUnreachableError", (cause) =>
				Effect.fail(new ChannelDeafError({target: targetRole, address, reason: cause.reason})),
			),
		);

	const send: Peer["send"] = (targetRole, kind, body, options) =>
		Effect.gen(function* () {
			const holders = yield* tracker.lookup(targetRole);
			// No live holder of the role at all ⇒ nobody to dial (distinct from a present-but-deaf inbox).
			if (!Arr.isReadonlyArrayNonEmpty(holders)) {
				return yield* new PeerUnreachableError({
					target: targetRole,
					reason: `no live peer for role "${targetRole}"`,
				});
			}
			// Claim-aware routing (#3886): a message that names a claimed resource (`options.claimResource`,
			// e.g. an `EngineNudge` about a PR an engine already holds) delivers to the CLAIM HOLDER's seat
			// only, so N-1 non-owning seats are spared a wake + a one-line read they discard. Everything
			// else — no key, unclaimed, a lapsed claim, or a holder not in the live set — keeps the #3770
			// broadcast fan. `selectDeliveryTargets` guarantees a non-empty subset, so this only narrows.
			const claimOwner = options?.claimResource
				? yield* tracker.claimHolder(options.claimResource)
				: Option.none<string>();
			const targets = selectDeliveryTargets(holders, claimOwner);
			// One logical message, delivered to the selected target(s). A bridge has one holder (an ordinary
			// point-to-point send); an engine pool has N, across which a per-item advisory reaches the seat
			// that OWNS the item — routed straight to it when the claim resolves, else fanned to all. This
			// replaced an `Arr.head` collapse that could only ever dial the head (#3770). Fanning stays safe
			// because the nudge is advisory/non-routing: a seat that does not own the item ignores it (ADR 0189).
			const envelope: InboxEnvelope = {
				messageId: randomUUID(),
				from: config.self,
				kind,
				body,
				at: new Date().toISOString(),
			};
			// Deliver to the WHOLE selected set before deciding the result — a fan must not fail-fast on one
			// deaf seat and skip the rest, so each dial is reified into a Result and every target is dialed.
			const results = yield* Effect.forEach(
				targets,
				(holder) => Effect.result(dialHolder(targetRole, holder.address, envelope)),
				{concurrency: "unbounded"},
			);
			// Delivered iff at least one live holder acked. The returned ack is a delivery RECEIPT for the
			// fan (which holder answered first is immaterial — every reachable holder received the same
			// envelope), NOT a routing choice like the old head-pick.
			const ack = Arr.findFirst(results, Result.isSuccess);
			if (Option.isSome(ack)) {
				return ack.value.success;
			}
			// No target acked ⇒ every selected recipient was deaf. Surface a ChannelDeafError — for a
			// singleton bridge this is exactly the one holder's own deaf error, so behavior is identical to
			// before the fan. `results` is non-empty (`targets` is) and here every entry is a failure, so one is present.
			const deaf = Arr.findFirst(results, Result.isFailure);
			return yield* Option.match(deaf, {
				onSome: (failure) => Effect.fail(failure.failure),
				onNone: () => Effect.die("unreachable: a non-empty fan with no ack must carry a failure"),
			});
		});

	return {
		self: config.self,
		role: config.role,
		address: config.address,
		received: inbox.received,
		announce,
		send,
	};
});
