import {randomUUID} from "node:crypto";
import {
	type ClientMessage,
	createClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import type {DiscoveryOutcome} from "../shared/wire.ts";

export type Discover = () => Promise<DiscoveryOutcome>;

const joinFrames = (frames: ReadonlyArray<Uint8Array>): Uint8Array => {
	const byteLength = frames.reduce((total, frame) => total + frame.byteLength, 0);
	const joined = new Uint8Array(byteLength);
	let offset = 0;
	for (const frame of frames) {
		joined.set(frame, offset);
		offset += frame.byteLength;
	}
	return joined;
};

const toProtocolSessions = (outcome: DiscoveryOutcome): Array<SessionMetadata> =>
	outcome.sessions.map((session) => ({
		id: session.identity.id,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		cwd: session.cwd,
		...(session.name === undefined ? {} : {sessionName: session.name}),
	}));

const failureMessage = (outcome: DiscoveryOutcome): string | undefined => {
	if (outcome.kind === "transport" || outcome.kind === "fatal") return outcome.message;
	return undefined;
};

export const handlePiProtocol = async (
	chunks: Iterable<Uint8Array>,
	discover: Discover,
	ids: {readonly connectionId?: string; readonly serverId?: string} = {},
): Promise<Uint8Array> => {
	const decoder = createClientMessageDecoder({maxFrameLength: 1024 * 1024});
	const messages: Array<ClientMessage> = [];
	for (const chunk of chunks) messages.push(...decoder.push(chunk));
	decoder.end();
	if (messages[0]?.type !== "hello")
		throw new Error("pi protocol requires hello as its first frame");
	if (messages[0].version !== PROTOCOL_VERSION) {
		return encodeServerMessage({
			type: "hello_error",
			error: {code: "version", message: `unsupported pi protocol version ${messages[0].version}`},
		});
	}

	const outcome = await discover();
	const sessions = toProtocolSessions(outcome);
	const responses: Array<ServerMessage> = [
		{
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: ids.connectionId ?? randomUUID(),
			snapshot: {
				serverId: ids.serverId ?? "tuval-local",
				protocolVersion: PROTOCOL_VERSION,
				revision: 0,
				sessions,
				models: [],
			},
		},
	];

	for (const message of messages.slice(1)) {
		if (message.type === "hello") throw new Error("pi protocol hello may only be sent once");
		const failure = failureMessage(outcome);
		if (failure !== undefined) {
			responses.push({
				type: "response",
				id: message.id,
				ok: false,
				error: {code: "internal_error", message: failure},
			});
			continue;
		}
		if (message.request.command !== "list") {
			responses.push({
				type: "response",
				id: message.id,
				ok: false,
				error: {code: "not_implemented", message: "Tuval currently supports session listing only"},
			});
			continue;
		}
		responses.push({
			type: "response",
			id: message.id,
			ok: true,
			result: {command: "list", sessions},
		});
	}
	return joinFrames(responses.map((response) => encodeServerMessage(response)));
};
