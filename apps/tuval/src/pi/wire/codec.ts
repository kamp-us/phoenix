/**
 * The wire seam. Every encode and decode Tuval's Pi protocol does goes through this file, so the
 * package that actually frames the bytes is named here and nowhere else. Today that is
 * `@earendil-works/pi-protocol@0.84.3` and the vocabulary beside this file is a verbatim
 * relocation of its schemas, which is what makes the 0.85.1 move a swap of this body rather than
 * a rewrite of every call site (epic #8518).
 *
 * Handing Tuval's own types to the package's functions and taking the package's back as Tuval's is
 * also the proof the relocation is faithful: a field that drifted from the 0.84.3 shape stops
 * typechecking here, in both directions, rather than at runtime.
 */

import {
	createClientMessageDecoder as createPiClientMessageDecoder,
	createServerMessageDecoder as createPiServerMessageDecoder,
	encodeClientMessage as encodePiClientMessage,
	encodeServerMessage as encodePiServerMessage,
	DEFAULT_MAX_FRAME_LENGTH as PI_DEFAULT_MAX_FRAME_LENGTH,
	parseClientMessage as parsePiClientMessage,
} from "@earendil-works/pi-protocol";
import type {ClientMessage, ServerMessage} from "./message.ts";

export {ProtocolValidationError} from "@earendil-works/pi-protocol";

/** Upper bound on one framed payload, in bytes, when a caller does not name its own. */
export const DEFAULT_MAX_FRAME_LENGTH: number = PI_DEFAULT_MAX_FRAME_LENGTH;

export interface FrameOptions {
	readonly maxFrameLength?: number;
}

/** Incrementally decodes and validates framed messages of one direction. */
export interface MessageDecoder<TMessage> {
	push(chunk: Uint8Array): TMessage[];
	end(): void;
}

export type ClientMessageDecoder = MessageDecoder<ClientMessage>;
export type ServerMessageDecoder = MessageDecoder<ServerMessage>;

/** Validates and encodes one complete length-prefixed client message. */
export const encodeClientMessage = (message: ClientMessage, options?: FrameOptions): Uint8Array =>
	encodePiClientMessage(message, options);

/** Validates and encodes one complete length-prefixed server message. */
export const encodeServerMessage = (message: ServerMessage, options?: FrameOptions): Uint8Array =>
	encodePiServerMessage(message, options);

/** Validates one already-decoded client message, throwing `ProtocolValidationError` if it is not. */
export const parseClientMessage = (value: unknown): ClientMessage => parsePiClientMessage(value);

export const createClientMessageDecoder = (options?: FrameOptions): ClientMessageDecoder =>
	createPiClientMessageDecoder(options);

export const createServerMessageDecoder = (options?: FrameOptions): ServerMessageDecoder =>
	createPiServerMessageDecoder(options);
