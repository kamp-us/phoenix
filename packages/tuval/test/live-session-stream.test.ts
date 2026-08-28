import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {NodeServices} from "@effect/platform-node";
import {describe, expect, it} from "@effect/vitest";
import {Effect, Stream} from "effect";
import type {LiveSessionService} from "../src/backend/live-session.js";
import {startTuval} from "../src/backend/server.js";
import type {LiveSessionEvent} from "../src/shared/live-session.js";
import {tryPromise} from "./test-effect.js";

const event: LiveSessionEvent = {
	_tag: "diagnostic",
	sequence: 2,
	sessionId: null,
	message: "streamed from the live session",
};

const liveSession: LiveSessionService = {
	current: () => Effect.succeed(null),
	attach: (sessionId) =>
		Effect.succeed({_tag: "refused", sessionId, code: "disconnected", reason: "not used"}),
	prompt: ({correlationId}) =>
		Effect.succeed({_tag: "refused", correlationId, code: "no-attachment", reason: "not used"}),
	release: () => Effect.succeed({_tag: "released", sessionId: null}),
	eventsAfter: (sequence = 0) => Effect.succeed(sequence < event.sequence ? [event] : []),
	events: (sequence = 0) => Stream.fromIterable(sequence < event.sequence ? [event] : []),
	dispose: () => Effect.void,
};

const snapshot = (revision: number): SessionSnapshot => ({
	id: "session-product-boundary",
	cwd: "/tmp/tuval",
	createdAt: 1,
	updatedAt: revision,
	phase: "idle",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	attached: true,
	locked: false,
	revision,
	transcript: [
		{id: "existing", role: "user", content: [{type: "text", text: "existing"}], timestamp: 1},
	],
	queuedSteer: [],
	queuedSteerCount: 0,
});

const syntheticPiTransport = (): ByteTransportFactory => (handlers) => {
	const decoder = new ClientMessageDecoder();
	return {
		async send(chunk) {
			for (const message of decoder.push(chunk)) {
				if (message.type === "hello") {
					handlers.onData(
						encodeServerMessage({
							type: "hello",
							version: PROTOCOL_VERSION,
							connectionId: "tuval-product-test",
							snapshot: {
								serverId: "synthetic",
								protocolVersion: PROTOCOL_VERSION,
								revision: 1,
								sessions: [{id: snapshot(1).id, cwd: "/tmp/tuval", createdAt: 1, updatedAt: 1}],
								models: [],
							},
						}),
					);
					continue;
				}
				const request = message.request;
				if (request.command === "attach") {
					handlers.onData(
						encodeServerMessage({
							type: "response",
							id: message.id,
							ok: true,
							result: {command: "attach", session: snapshot(1)},
						}),
					);
					continue;
				}
				if (request.command === "prompt") {
					handlers.onData(
						encodeServerMessage({
							type: "event",
							event: {
								type: "session_progress",
								sessionId: request.sessionId,
								progress: {
									type: "item_started",
									item: {
										id: "streamed",
										role: "assistant",
										content: [{type: "text", text: "hello"}],
										model: {provider: "anthropic", id: "claude-sonnet"},
										timestamp: 2,
										status: "streaming",
									},
								},
							},
						}),
					);
					handlers.onData(
						encodeServerMessage({
							type: "response",
							id: message.id,
							ok: true,
							result: {command: "prompt", session: snapshot(2)},
						}),
					);
					continue;
				}
				if (request.command === "detach") {
					handlers.onData(
						encodeServerMessage({
							type: "response",
							id: message.id,
							ok: true,
							result: {command: "detach", sessionId: request.sessionId},
						}),
					);
				}
			}
		},
		close: handlers.onClose,
	};
};

const fate = (url: string, operations: ReadonlyArray<Record<string, unknown>>) =>
	tryPromise(() =>
		fetch(`${url}/fate`, {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({version: 1, operations}),
		}).then((response) => response.json()),
	);

describe("live-session server transport", () => {
	it.layer(NodeServices.layer)((it) => {
		it.effect(
			"streams ordered service events and closes an active SSE request deterministically",
			() =>
				Effect.gen(function* () {
					const server = yield* startTuval({liveSession, openBrowser: () => Effect.void});
					const response = yield* tryPromise(() =>
						fetch(`${server.url}/fate/live?afterSequence=1`),
					);
					expect(response.headers.get("content-type")).toContain("text/event-stream");
					const chunk = yield* tryPromise(() => response.body!.getReader().read());
					expect(new TextDecoder().decode(chunk.value)).toContain(`data: ${JSON.stringify(event)}`);

					const hanging = yield* tryPromise(() => fetch(`${server.url}/fate/live?afterSequence=2`));
					yield* server.close();
					const closed = yield* tryPromise(() => hanging.body!.getReader().read());
					expect(closed.done).toBe(true);
				}),
		);

		it.effect("drives synthetic Pi attach, prompt, and live delivery through fate and SSE", () =>
			Effect.gen(function* () {
				const server = yield* startTuval({
					liveSessionTransport: syntheticPiTransport(),
					openBrowser: () => Effect.void,
				});
				const attached = (yield* fate(server.url, [
					{
						id: "attach",
						kind: "mutation",
						name: "liveSession.attach",
						input: {sessionId: snapshot(1).id},
						select: [],
					},
				])) as {results: Array<{data: {session: {lastEventSequence: number}}}>};
				const afterSequence = attached.results[0]!.data.session.lastEventSequence;
				const abort = new AbortController();
				yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
				const streamed = yield* tryPromise(() =>
					fetch(`${server.url}/fate/live?afterSequence=${afterSequence}`, {signal: abort.signal}),
				);

				const prompted = yield* fate(server.url, [
					{
						id: "prompt",
						kind: "mutation",
						name: "liveSession.prompt",
						input: {correlationId: "prompt-product", text: "hello"},
						select: [],
					},
				]);
				expect(prompted).toMatchObject({
					results: [{data: {_tag: "acknowledged", correlationId: "prompt-product"}, ok: true}],
				});
				const chunk = yield* tryPromise(() => streamed.body!.getReader().read());
				expect(new TextDecoder().decode(chunk.value)).toContain('"streamed"');
			}),
		);
	});
});
