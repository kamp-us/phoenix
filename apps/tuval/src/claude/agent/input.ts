/**
 * The session's input channel: the `AsyncIterable<SDKUserMessage>` handed to `query()`, and the
 * push that puts one turn on it.
 *
 * Handing `query()` an iterable rather than a string is what makes the session streaming-input, and
 * that is what `Query.interrupt` and `Query.setPermissionMode` require ("only supported when
 * streaming input/output is used", `sdk.d.ts`). The SDK consumes the iterable through
 * `Query.streamInput` itself: `query()` writes a string prompt straight to the transport and
 * otherwise calls `queryInstance.streamInput(prompt)` (`sdk.mjs`, the prompt-wiring function), so
 * one iterable is the whole input path and a second `streamInput` call would open a second one.
 *
 * Plain Promises rather than an Effect queue on purpose: this object is consumed by a `for await`
 * inside the SDK, on no fiber of ours. The Effect side of the layer pushes into it and never reads
 * it.
 */

import type {SDKUserMessage} from "@anthropic-ai/claude-agent-sdk";

export interface InputChannel {
	readonly messages: AsyncIterable<SDKUserMessage>;
	readonly push: (message: SDKUserMessage) => void;
	/** Ends the iterable, which is how the SDK sees stdin close. Idempotent. */
	readonly end: () => void;
}

export const inputChannel = (): InputChannel => {
	const buffered: Array<SDKUserMessage> = [];
	let waiting: ((message: SDKUserMessage | null) => void) | null = null;
	let ended = false;

	const push = (message: SDKUserMessage): void => {
		if (ended) return;
		const waiter = waiting;
		if (waiter === null) {
			buffered.push(message);
			return;
		}
		waiting = null;
		waiter(message);
	};

	const end = (): void => {
		if (ended) return;
		ended = true;
		const waiter = waiting;
		if (waiter === null) return;
		waiting = null;
		waiter(null);
	};

	const next = (): Promise<SDKUserMessage | null> => {
		const held = buffered.shift();
		if (held !== undefined) return Promise.resolve(held);
		if (ended) return Promise.resolve(null);
		return new Promise((resolve) => {
			waiting = resolve;
		});
	};

	const messages: AsyncIterable<SDKUserMessage> = {
		async *[Symbol.asyncIterator]() {
			while (true) {
				const message = await next();
				if (message === null) return;
				yield message;
			}
		},
	};

	return {messages, push, end};
};

/** One turn of operator text as the SDK's user message. `content` may be a bare string (`MessageParam`). */
export const userMessage = (sessionId: string, text: string): SDKUserMessage => ({
	type: "user",
	message: {role: "user", content: text},
	parent_tool_use_id: null,
	session_id: sessionId,
});
