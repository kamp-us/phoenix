/**
 * peer/peer — the session-edge peer: an `RpcServer` inbox + an `RpcClient` dialer that
 * announces to the tracker and sends peer-to-peer. Generic (crew-agnostic); see the
 * boundary note in `../index.ts`.
 *
 * `make` is scoped: on start it announces its role + inbox address to the tracker and
 * holds the presence for its scope's lifetime — connection-is-lease (#3035); scope close
 * frees the role. `send` looks the target role up via the tracker (the tracker never
 * relays) and dials that peer's inbox directly. Both offline paths — no live peer for the
 * role, and a dial that fails — surface as `PeerUnreachableError`, never a silent drop.
 */

import {randomUUID} from "node:crypto";
import {Effect, Option} from "effect";
import {Dialer} from "./dialer.ts";
import {PeerUnreachableError} from "./errors.ts";
import {Inbox, type InboxAck, type InboxEnvelope} from "./inbox.ts";
import {Tracker} from "./tracker.ts";

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
	/** Send a typed message to whichever live peer serves `targetRole`; resolves to its inbox-ack. */
	readonly send: (
		targetRole: string,
		kind: string,
		body: unknown,
	) => Effect.Effect<InboxAck, PeerUnreachableError>;
}

export const make = Effect.fn("Peer.make")(function* (config: PeerConfig) {
	const inbox = yield* Inbox;
	const tracker = yield* Tracker;
	const dialer = yield* Dialer;

	// Announce holds the role lease for this scope's lifetime — connection-is-lease (#3035).
	yield* tracker.announce({role: config.role, peer: config.self, address: config.address});

	const send: Peer["send"] = (targetRole, kind, body) =>
		Effect.gen(function* () {
			const present = yield* tracker.lookup(targetRole);
			if (Option.isNone(present)) {
				return yield* new PeerUnreachableError({
					target: targetRole,
					reason: `no live peer for role "${targetRole}"`,
				});
			}
			const envelope: InboxEnvelope = {
				messageId: randomUUID(),
				from: config.self,
				kind,
				body,
				at: new Date().toISOString(),
			};
			return yield* dialer.send(present.value.address, envelope);
		});

	return {
		self: config.self,
		role: config.role,
		address: config.address,
		received: inbox.received,
		send,
	};
});
