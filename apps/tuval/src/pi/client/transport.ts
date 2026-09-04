/**
 * The `ByteTransport` the 0.84.3 pin does not export. Pi ships a Unix-socket factory
 * (`@earendil-works/pi-client/unix`) and nothing over a WebSocket, and Node 26 ships the WebSocket
 * *client* as a global while `ws` supplies only the server half the loopback listener uses — so the
 * dial side is ours. Hand-derived from the spike's `play.ts` (#7469, founder gist); nothing is
 * imported from it, and the shape follows the pin's own `unix.js` so the two read alike.
 *
 * Every listener body here is total: it computes a verdict and hands it on, never throws. A throw
 * out of an `EventTarget` listener is an `uncaughtException`
 * ([Node.js, `events`, "`EventTarget` error handling"](https://nodejs.org/api/events.html#eventtarget-error-handling)),
 * which kills the Pi process — the same boundary `.patterns/node-listener-total-boundary.md` names
 * on the server side, and it reaches a `WebSocket` because that is an `EventTarget`, not an
 * `EventEmitter`.
 */

import type {
	ByteTransport,
	ByteTransportFactory,
	ByteTransportHandlers,
} from "@earendil-works/pi-client";
import {DEFAULT_MAX_FRAME_LENGTH} from "@earendil-works/pi-protocol";

/** Four frames of slack, the bound the pin's own Unix transport defaults to. */
export const DEFAULT_MAX_PENDING_BYTES = DEFAULT_MAX_FRAME_LENGTH * 4;

export interface WebSocketTransportOptions {
	/** The dial URL, capability token included — one per Pi process launch. */
	readonly url: string;
	readonly maxPendingBytes?: number;
}

/**
 * Creates fresh connected WebSocket transports for `PiClient` connection attempts. The factory is
 * re-invoked on every `connect`/`reconnect`, so it holds no socket of its own.
 */
export const webSocketTransportFactory = (
	options: WebSocketTransportOptions,
): ByteTransportFactory => {
	if (!URL.canParse(options.url)) {
		throw new TypeError("WebSocket transport url must be an absolute URL");
	}
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("WebSocket transport maxPendingBytes must be a positive safe integer");
	}
	return (handlers) => openWebSocket(options.url, maxPendingBytes, handlers);
};

const bytesOf = (data: unknown): Uint8Array | undefined => {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data))
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return undefined;
};

const openWebSocket = (
	url: string,
	maxPendingBytes: number,
	handlers: ByteTransportHandlers,
): Promise<ByteTransport> =>
	new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		let connected = false;
		let terminal = false;

		// Exactly one terminal handler, and only after the transport was handed over: before that,
		// the failure belongs to the factory's promise, which is where `PiClient` is waiting.
		const terminate = (fail: (error: Error) => void, error: Error): void => {
			if (terminal) return;
			terminal = true;
			if (connected) fail(error);
			else reject(error);
		};

		socket.addEventListener("open", () => {
			if (terminal) return;
			connected = true;
			resolve(
				new WebSocketByteTransport(socket, maxPendingBytes, () => {
					terminal = true;
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			if (terminal) return;
			const bytes = bytesOf(event.data);
			if (bytes === undefined) {
				socket.close();
				terminate(handlers.onError, new TypeError("Pi frames must arrive as binary"));
				return;
			}
			handlers.onData(bytes);
		});
		// A WHATWG `error` event carries no cause — the reason, when there is one, arrives on the
		// `close` event that follows it, and by then the transport is already terminal.
		socket.addEventListener("error", () => {
			terminate(handlers.onError, new Error(`WebSocket transport to ${url} failed`));
		});
		socket.addEventListener("close", (event) => {
			terminate(
				() => handlers.onClose(),
				new Error(`WebSocket transport closed before connecting (code ${event.code})`),
			);
		});
	});

class WebSocketByteTransport implements ByteTransport {
	readonly #socket: WebSocket;
	readonly #maxPendingBytes: number;
	readonly #markLocalClose: () => void;
	#closed = false;

	constructor(socket: WebSocket, maxPendingBytes: number, markLocalClose: () => void) {
		this.#socket = socket;
		this.#maxPendingBytes = maxPendingBytes;
		this.#markLocalClose = markLocalClose;
	}

	/**
	 * Invocation order is delivery order without a write queue of our own: `send()` enqueues the
	 * data synchronously and raises `bufferedAmount` by its length, and the queue drains in order
	 * over the one connection ([WHATWG HTML, "The `WebSocket` interface", `send(data)`](https://html.spec.whatwg.org/multipage/web-sockets.html#dom-websocket-send)).
	 * `transport.unit.test.ts` pins the property against a real server rather than trusting it.
	 */
	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("WebSocket transport chunks must be Uint8Array"));
		}
		if (this.#closed) return Promise.reject(new Error("WebSocket transport is closed"));
		if (this.#socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket transport is not open"));
		}
		if (this.#socket.bufferedAmount + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("WebSocket transport exceeded its pending byte limit"));
		}
		try {
			// A copy, because the caller owns its buffer and `send` reads it asynchronously.
			this.#socket.send(chunk.slice());
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return Promise.resolve();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#markLocalClose();
		this.#socket.close();
	}
}
