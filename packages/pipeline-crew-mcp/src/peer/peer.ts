/**
 * peer/peer — the session-edge peer: an `RpcServer` inbox + an `RpcClient` dialer that
 * announces to the tracker and sends peer-to-peer. Generic (crew-agnostic); see the
 * boundary note in `../index.ts`.
 *
 * `make` reserves this peer's role slot as a BARE lease (holds the slot + backs the crew
 * cardinality claim + connection-is-lease, #3035) but does NOT make it discoverable. Becoming a
 * live peer is a separate `announce` step the caller runs once its inbox is attached and serving,
 * so presence reflects a live channel half, not mere construction (#3628). `send` looks the target role up via the
 * tracker (the tracker never relays) and dials that peer's inbox directly. A send to a role
 * with NO live peer surfaces as `PeerUnreachableError`; a send to a role that IS present but
 * whose inbox will not answer surfaces as a distinguishable `ChannelDeafError`, fast — never a
 * silent drop, never a hang.
 */

import {randomUUID} from "node:crypto";
import {Duration, Effect, Option, type Scope} from "effect";
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
	 * Send a typed message to whichever live peer serves `targetRole`; resolves to its inbox-ack. A
	 * role with no live peer fails with `PeerUnreachableError`; a role that is present but whose inbox
	 * will not answer fails with a distinguishable `ChannelDeafError`, fast.
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

	const send: Peer["send"] = (targetRole, kind, body) =>
		Effect.gen(function* () {
			const present = yield* tracker.lookup(targetRole);
			if (Option.isNone(present)) {
				return yield* new PeerUnreachableError({
					target: targetRole,
					reason: `no live peer for role "${targetRole}"`,
				});
			}
			const address = present.value.address;
			const envelope: InboxEnvelope = {
				messageId: randomUUID(),
				from: config.self,
				kind,
				body,
				at: new Date().toISOString(),
			};
			// The tracker returned a live lease, so a dial that won't complete is channel-deaf — presence
			// reflected a stale socket file, not a live inbox (#3628). Fold BOTH a fast dial refusal (a
			// dead/orphaned socket → PeerUnreachableError) and a genuine hang (the bounded timeout) into one
			// distinguishable ChannelDeafError, so the caller tells "registered but deaf" from "nobody there".
			return yield* dialer.send(address, envelope).pipe(
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
