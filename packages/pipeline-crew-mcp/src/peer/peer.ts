/**
 * peer/peer — the session-edge peer: an `RpcServer` inbox + an `RpcClient` dialer that
 * announces to the tracker and sends peer-to-peer. Generic (crew-agnostic); see the
 * boundary note in `../index.ts`.
 *
 * `make` reserves this peer's role slot as a BARE lease (holds the slot + backs the crew
 * cardinality claim + connection-is-lease, #3035) but does NOT make it discoverable. Becoming a
 * live peer is a separate `announce` step the caller runs once its inbox is attached and serving,
 * so presence reflects a live channel half, not mere construction (#3628). `send` looks the target
 * role up via the tracker (the tracker never relays) and FANS the message to every live holder's
 * inbox directly — one holder for a singleton bridge, every seat for an engine pool, so a per-item
 * advisory reaches the seat that owns the item rather than only the head (#3770). A send to a role
 * with NO live peer surfaces as `PeerUnreachableError`; a send whose holders are all present but
 * deaf surfaces as a distinguishable `ChannelDeafError`, fast — never a silent drop, never a hang.
 */

import {randomUUID} from "node:crypto";
import {Duration, Effect, Option, Result, type Scope} from "effect";
import * as Arr from "effect/Array";
import {Dialer} from "./dialer.ts";
import {ChannelDeafError, PeerUnreachableError} from "./errors.ts";
import {Inbox, type InboxAck, type InboxEnvelope} from "./inbox.ts";
import {Tracker} from "./tracker.ts";

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
	 * Send a typed message to `targetRole`, fanned to EVERY live holder of the role; resolves to a
	 * delivery-receipt inbox-ack (delivered iff at least one holder acked). A role with no live peer
	 * fails with `PeerUnreachableError`; a role whose holders are all present but deaf fails with a
	 * distinguishable `ChannelDeafError`, fast.
	 */
	readonly send: (
		targetRole: string,
		kind: string,
		body: unknown,
	) => Effect.Effect<InboxAck, PeerUnreachableError | ChannelDeafError>;
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

	const send: Peer["send"] = (targetRole, kind, body) =>
		Effect.gen(function* () {
			const holders = yield* tracker.lookup(targetRole);
			// No live holder of the role at all ⇒ nobody to dial (distinct from a present-but-deaf inbox).
			if (!Arr.isReadonlyArrayNonEmpty(holders)) {
				return yield* new PeerUnreachableError({
					target: targetRole,
					reason: `no live peer for role "${targetRole}"`,
				});
			}
			// One logical message, FANNED to every live holder of the role — not routed to a single seat
			// (#3770). A bridge has one holder, so this is an ordinary point-to-point send; an engine pool
			// has N, so a per-item advisory (`EngineNudge`) reaches the seat that OWNS the item regardless
			// of which seat that is. This replaces an `Arr.head` collapse that could only ever dial the
			// head, so a non-head owner never heard the nudge. Fanning is safe because the nudge is
			// advisory/non-routing: a seat that does not own the item ignores it (ADR 0189).
			const envelope: InboxEnvelope = {
				messageId: randomUUID(),
				from: config.self,
				kind,
				body,
				at: new Date().toISOString(),
			};
			// Deliver to the WHOLE pool before deciding the result — a fan must not fail-fast on one deaf
			// seat and skip the rest, so each dial is reified into a Result and every holder is dialed.
			const results = yield* Effect.forEach(
				holders,
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
			// No holder acked ⇒ the entire live pool was deaf. Surface a ChannelDeafError — for a singleton
			// bridge this is exactly the one holder's own deaf error, so behavior is identical to before the
			// fan. `results` is non-empty (holders is) and here every entry is a failure, so one is present.
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
