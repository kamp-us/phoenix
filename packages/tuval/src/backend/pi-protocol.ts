import {type ByteTransportFactory, PiClient} from "@earendil-works/pi-client";
import {
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";

export interface ProtocolTransportOptions {
	readonly failWith?: Error;
}

const serverSnapshot = (sessions: ReadonlyArray<SessionMetadata>) => ({
	serverId: "tuval",
	protocolVersion: PROTOCOL_VERSION,
	revision: 1,
	sessions: [...sessions],
	models: [],
});

export const makeDiscoveryTransport =
	(
		sessions: ReadonlyArray<SessionMetadata>,
		options: ProtocolTransportOptions = {},
	): ByteTransportFactory =>
	(handlers) => {
		const decoder = new ClientMessageDecoder();
		let closed = false;
		let greeted = false;
		const deliver = (message: ServerMessage): void => {
			if (!closed) handlers.onData(encodeServerMessage(message));
		};
		return {
			async send(chunk) {
				if (closed) throw new Error("Tuval pi transport is closed");
				if (options.failWith !== undefined) {
					closed = true;
					handlers.onError(options.failWith);
					return;
				}
				for (const message of decoder.push(chunk)) {
					if (message.type === "hello") {
						if (message.version !== PROTOCOL_VERSION) {
							deliver({
								type: "hello_error",
								error: {
									code: "version",
									message: `Unsupported pi protocol version ${message.version}`,
								},
							});
							continue;
						}
						greeted = true;
						deliver({
							type: "hello",
							version: PROTOCOL_VERSION,
							connectionId: "tuval-discovery",
							snapshot: serverSnapshot(sessions),
						});
						continue;
					}
					if (!greeted) {
						deliver({
							type: "response",
							id: message.id,
							ok: false,
							error: {code: "invalid_request", message: "Client hello is required"},
						});
						continue;
					}
					if (message.request.command === "list") {
						deliver({
							type: "response",
							id: message.id,
							ok: true,
							result: {command: "list", sessions: [...sessions]},
						});
						continue;
					}
					deliver({
						type: "response",
						id: message.id,
						ok: false,
						error: {
							code: "not_implemented",
							message: `Tuval discovery does not implement ${message.request.command}`,
						},
					});
				}
			},
			close() {
				if (closed) return;
				closed = true;
				try {
					decoder.end();
					handlers.onClose();
				} catch (error) {
					handlers.onError(error instanceof Error ? error : new Error(String(error)));
				}
			},
		};
	};

export const listSessionsThroughProtocol = async (
	sessions: ReadonlyArray<SessionMetadata>,
	options?: ProtocolTransportOptions,
): Promise<ReadonlyArray<SessionMetadata>> => {
	const client = await PiClient.connect({
		transportFactory: makeDiscoveryTransport(sessions, options),
	});
	try {
		return await client.listSessions();
	} finally {
		await client.dispose();
	}
};
