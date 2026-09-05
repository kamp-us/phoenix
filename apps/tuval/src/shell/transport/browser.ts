/**
 * The transport's browser half: the client that opens the socket, the wire it speaks, and the
 * refusals it reads. Split from `./index.ts` because that barrel also carries `./handshake.ts` and
 * `./server.ts`, whose first imports are `node:crypto` and `node:http` — a page importing the barrel
 * for `attach` pulled both into its bundle and threw at module load (#7836).
 */

export {
	type AttachedProcess,
	type AttachOptions,
	attach,
	type PageAttachment,
	SHELL_PROGRAM_ID,
} from "./client.ts";
export {
	type AttachRefused,
	type HandshakeRefusal,
	HandshakeRefused,
	NoSuchProcess,
	PlacementUnsupported,
	UndecodableMessage,
	type UndecodableReason,
} from "./errors.ts";
export {
	ATTACH_KIND,
	ATTACH_REFUSED_KIND,
	type AttachFrame,
	type AttachRefusedFrame,
	type ClientFrame,
	DETACH_KIND,
	type Decoded,
	type DetachFrame,
	DISPATCH_KIND,
	DISPATCHED_KIND,
	type DispatchedFrame,
	type DispatchFrame,
	decodeClientFrame,
	decodeServerFrame,
	encodeFrame,
	fromWireRow,
	PROCESS_STATE_KIND,
	type ProcessStateFrame,
	type ServerFrame,
	TABLE_KIND,
	type TableFrame,
	tableFrame,
	toWireRow,
	type WireRow,
} from "./wire.ts";
