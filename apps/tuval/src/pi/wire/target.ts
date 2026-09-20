/**
 * Who a request is addressed to. Protocol 8 fences every call to one logical server, and a
 * session call additionally to one durable session and one live attachment — which is where
 * Tuval's ownership table now lives on the wire (ADR 0366).
 *
 * `serverId` is a canonical lowercase UUIDv4: `pi-protocol`'s `ServerIdSchema` carries that
 * pattern, and `pi-client`'s constructor throws a `TypeError` on anything else, so a server that
 * mints an id any other way cannot be dialled.
 */

/** A server-wide call: session listing, opening, attaching, detaching. */
export interface ServerTarget {
	readonly serverId: string;
}

/** A call on a session this connection holds an attachment on. */
export interface SessionTarget {
	readonly serverId: string;
	readonly sessionId: string;
	readonly attachmentId: string;
}

export type RpcTarget = ServerTarget | SessionTarget;

export const isSessionTarget = (target: RpcTarget): target is SessionTarget =>
	"sessionId" in target;
