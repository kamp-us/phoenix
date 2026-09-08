/**
 * The wire seam. Every encode and decode Tuval's Pi protocol does goes through this file, so
 * `@earendil-works/pi-protocol` is named here and nowhere else (ADR 0366).
 *
 * At 0.85.1 the package carries a thin RPC envelope whose every payload is
 * `Type.Unsafe(Type.Unknown())`, so Tuval's own vocabulary beside this file *is* the payload: a
 * `Command` rides inside a `request`'s `call`, a `CommandResult` inside a `response`'s `result`,
 * and a `ServerEvent` inside a `service_update`'s `update`. The package validates the envelope and
 * nothing else, which is why the 0.84.3 schema's per-snapshot validation cost — and ADR 0364's
 * patch for it — retire with this pin.
 *
 * The `call` is shaped as a Chord `ServiceCall` because `pi-client`'s `Client.request` puts every
 * outbound call through Chord's `parseServiceCall` before framing it. Tuval runs no Chord service:
 * the shape is the envelope's, and the `Command` in `args[0]` is the whole message.
 */

import {
	decodeCbor,
	encodeFrame,
	encodeClientMessage as encodePiClientMessage,
	encodeServerMessage as encodePiServerMessage,
	FrameDecoder,
	DEFAULT_MAX_FRAME_LENGTH as PI_DEFAULT_MAX_FRAME_LENGTH,
	ClientMessageDecoder as PiClientMessageDecoder,
	ServerMessageDecoder as PiServerMessageDecoder,
	parseClientMessage as parsePiClientMessage,
	parseServerMessage as parsePiServerMessage,
} from "@earendil-works/pi-protocol";
import type {Command, CommandResult, ProtocolError, ProtocolErrorCode} from "./command.ts";
import type {ClientMessage, ServerEvent, ServerMessage} from "./message.ts";
import {SERVICE_ID, SESSION_SUBSCRIPTION_ID} from "./message.ts";

export {ProtocolValidationError} from "@earendil-works/pi-protocol";

import {ProtocolValidationError} from "@earendil-works/pi-protocol";

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

/**
 * What the envelope calls an opaque payload. Tuval's own payload types are interfaces, and
 * TypeScript will not widen an interface to a JSON index signature however JSON its fields are, so
 * the widening happens here — at the one seam where both ends of the socket run the package's own
 * `isJsonValue` over the value anyway.
 */
type WirePayload = Extract<
	Parameters<typeof encodePiServerMessage>[0],
	{type: "service_update"}
>["update"];

const asPayload = (value: unknown): WirePayload => value as WirePayload;

/**
 * Reads a payload back as the Tuval type that was put in it.
 *
 * This is the boundary the no-assertions rule points at, and protocol 8 leaves nothing to decode
 * against: every payload is `Type.Unsafe(Type.Unknown())`, so the package validates the envelope
 * and hands the payload back untyped. Tuval writes both ends of this socket, and the outbound half
 * — `encodeClientMessage` / `encodeServerMessage` above — only takes Tuval's own typed unions, so
 * the shape is held at the seam rather than lost. A `Schema` here would put per-message validation
 * of the whole transcript back on the wire, which is the 5.2 s cost this upgrade exists to remove
 * (ADR 0366); the one thing it would catch is a peer that is not Tuval, and there is none.
 */
const asTuval = <T>(payload: unknown): T => payload as T;

const refuse = (what: string): never => {
	throw new ProtocolValidationError(`Invalid Tuval ${what} payload`);
};

const protocolErrorCodes: ReadonlySet<string> = new Set<ProtocolErrorCode>([
	"version",
	"busy",
	"session_locked",
	"not_found",
	"invalid_request",
	"not_implemented",
	"internal_error",
]);

/**
 * Protocol 8 types an error code as any non-empty string, while Tuval names seven. A code outside
 * them is a peer this host does not speak; it lands on `internal_error` with the raw code kept in
 * the message rather than being passed off as one of the seven.
 */
const protocolErrorOf = (error: {
	readonly code: string;
	readonly message: string;
}): ProtocolError =>
	protocolErrorCodes.has(error.code)
		? {code: error.code as ProtocolErrorCode, message: error.message}
		: {code: "internal_error", message: `${error.code}: ${error.message}`};

const toPiClient = (message: ClientMessage): Parameters<typeof encodePiClientMessage>[0] => {
	if (message.type === "request") {
		return {
			type: "request",
			id: message.id,
			target: message.target,
			call: asPayload({
				serviceId: SERVICE_ID,
				member: message.request.command,
				args: [message.request],
			}),
		};
	}
	return message;
};

const fromPiClient = (message: ReturnType<typeof parsePiClientMessage>): ClientMessage => {
	if (message.type !== "request") return message;
	const call = message.call;
	if (
		call === null ||
		typeof call !== "object" ||
		Array.isArray(call) ||
		!("args" in call) ||
		!Array.isArray(call.args)
	) {
		return refuse("call");
	}
	const command = call.args[0];
	if (command === null || typeof command !== "object" || !("command" in command)) {
		return refuse("command");
	}
	return {
		type: "request",
		id: message.id,
		target: message.target,
		request: asTuval<Command>(command),
	};
};

const toPiServer = (message: ServerMessage): Parameters<typeof encodePiServerMessage>[0] => {
	switch (message.type) {
		case "response":
			return message.ok
				? {type: "response", id: message.id, ok: true, result: asPayload(message.result)}
				: {type: "response", id: message.id, ok: false, error: message.error};
		case "service_update":
			return {
				type: "service_update",
				subscriptionId: message.subscriptionId,
				update: asPayload(message.update),
			};
		default:
			return message;
	}
};

const fromPiServer = (message: ReturnType<typeof parsePiServerMessage>): ServerMessage => {
	switch (message.type) {
		case "response":
			return message.ok
				? {
						type: "response",
						id: message.id,
						ok: true,
						result: asTuval<CommandResult>(message.result),
					}
				: {type: "response", id: message.id, ok: false, error: protocolErrorOf(message.error)};
		case "service_update":
			return {
				type: "service_update",
				subscriptionId: message.subscriptionId,
				update: asTuval<ServerEvent>(message.update),
			};
		case "hello_error":
			return {type: "hello_error", error: protocolErrorOf(message.error)};
		default:
			return message;
	}
};

const mapped = <TIn, TOut>(
	decoder: {push(chunk: Uint8Array): TIn[]; end(): void},
	map: (message: TIn) => TOut,
): MessageDecoder<TOut> => ({
	push: (chunk) => decoder.push(chunk).map(map),
	end: () => decoder.end(),
});

/** Validates and encodes one complete length-prefixed client message. */
export const encodeClientMessage = (message: ClientMessage, options?: FrameOptions): Uint8Array =>
	encodePiClientMessage(toPiClient(message), options);

/** Validates and encodes one complete length-prefixed server message. */
export const encodeServerMessage = (message: ServerMessage, options?: FrameOptions): Uint8Array =>
	encodePiServerMessage(toPiServer(message), options);

/** Validates one already-decoded client message, throwing `ProtocolValidationError` if it is not. */
export const parseClientMessage = (value: unknown): ClientMessage =>
	fromPiClient(parsePiClientMessage(value));

export const createClientMessageDecoder = (options?: FrameOptions): ClientMessageDecoder =>
	mapped(new PiClientMessageDecoder(options), fromPiClient);

export const createServerMessageDecoder = (options?: FrameOptions): ServerMessageDecoder =>
	mapped(new PiServerMessageDecoder(options), fromPiServer);

/** What one chunk of inbound server bytes held, split by who consumes it. */
export interface SplitFrames {
	/** Tuval's own session-stream updates, already decoded. */
	readonly events: ReadonlyArray<ServerEvent>;
	/** Every other frame, re-framed byte for byte for `pi-client`'s own decoder. */
	readonly forward: ReadonlyArray<Uint8Array>;
}

/**
 * Splits Tuval's session stream out of the inbound byte stream before `pi-client`'s `Client` sees
 * it.
 *
 * `Client` routes a `service_update` only to a subscription its own `subscribeService` opened, and
 * drops every other one silently (`client.js`, `#handleMessage`) — so Tuval's events cannot reach
 * the app through it. Subscribing for real would mean speaking Chord's replicated-state protocol,
 * which is the next slice's question, not this one's. Splitting here costs nothing extra: each
 * frame is CBOR-decoded once, and a forwarded frame is handed on as the bytes it arrived as.
 */
export const createServerFrameSplitter = (
	options?: FrameOptions,
): {push(chunk: Uint8Array): SplitFrames} => {
	const frames = new FrameDecoder(options);
	const maxByteLength = options?.maxFrameLength ?? PI_DEFAULT_MAX_FRAME_LENGTH;
	return {
		push: (chunk) => {
			const events: ServerEvent[] = [];
			const forward: Uint8Array[] = [];
			for (const payload of frames.push(chunk)) {
				const message = parsePiServerMessage(decodeCbor(payload, {maxByteLength}));
				if (
					message.type === "service_update" &&
					message.subscriptionId === SESSION_SUBSCRIPTION_ID
				) {
					events.push(asTuval<ServerEvent>(message.update));
					continue;
				}
				forward.push(encodeFrame(payload));
			}
			return {events, forward};
		},
	};
};
