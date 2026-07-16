/**
 * peer/dialer — the sending half of a session-edge peer: dial a target inbox address and
 * deliver an envelope, resolving to its inbox-ack or failing loudly. Generic
 * (crew-agnostic); see the boundary note in `../index.ts`.
 *
 * Transport-pluggable by construction (Effect RPC is the seam the epic keeps): `Dialer`
 * is an abstract port; `layerFromConnect` builds it from a `connect` that yields an inbox
 * `RpcClient` — the real one dials the peer's socket (#3059), a test one is in-memory. A
 * connect or delivery failure becomes a typed `PeerUnreachableError`, never a silent drop.
 */
import {Context, Effect, Layer} from "effect";
import {PeerUnreachableError} from "./errors.ts";
import type {InboxAck, InboxEnvelope} from "./inbox.ts";

/** The dialer's view of a target inbox: just the one `Deliver` call the `PeerInbox` group exposes. */
export interface InboxRpcClient {
	readonly Deliver: (envelope: InboxEnvelope) => Effect.Effect<InboxAck, unknown>;
}

/** Open a connection to a target inbox address, or fail loudly if it can't be reached. */
export type Connect = (address: string) => Effect.Effect<InboxRpcClient, PeerUnreachableError>;

export class Dialer extends Context.Service<
	Dialer,
	{
		readonly send: (
			address: string,
			envelope: InboxEnvelope,
		) => Effect.Effect<InboxAck, PeerUnreachableError>;
	}
>()("@kampus/pipeline-crew-mcp/peer/Dialer") {
	/**
	 * A dialer over a `connect` capability: dial, deliver, ack. A delivery-side failure
	 * (dead socket, decode error) collapses to `PeerUnreachableError` so every unreachable
	 * path — absent target and broken connection alike — surfaces as one typed failure.
	 */
	static readonly layerFromConnect = (connect: Connect): Layer.Layer<Dialer> =>
		Layer.succeed(Dialer, {
			send: (address, envelope) =>
				connect(address).pipe(
					Effect.flatMap((client) =>
						client
							.Deliver(envelope)
							.pipe(
								Effect.mapError(
									(cause) => new PeerUnreachableError({target: address, reason: String(cause)}),
								),
							),
					),
				),
		});
}
