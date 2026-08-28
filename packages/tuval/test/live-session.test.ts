import type {ByteTransportFactory, ByteTransportHandlers} from "@earendil-works/pi-client";
import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeCbor,
	encodeFrame,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerEvent,
	type ServerMessage,
	type SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Schema, Stream} from "effect";
import {PiLiveSession} from "../src/backend/live-session.js";
import {
	AttachLiveSessionOutcome,
	LiveSessionEvent,
	LiveSessionView,
} from "../src/shared/live-session.js";

const user = (id: string, text: string, timestamp: number) => ({
	id,
	role: "user" as const,
	content: [{type: "text" as const, text}],
	timestamp,
});

type AssistantItem = Extract<SessionSnapshot["transcript"][number], {role: "assistant"}>;
type StreamingAssistant = Extract<AssistantItem, {status: "streaming"}>;
type CompleteAssistant = Extract<AssistantItem, {status: "complete"}>;

function assistant(id: string, text: string, timestamp: number): CompleteAssistant;
function assistant(
	id: string,
	text: string,
	timestamp: number,
	status: "streaming",
): StreamingAssistant;
function assistant(
	id: string,
	text: string,
	timestamp: number,
	status: "streaming" | "complete" = "complete",
): AssistantItem {
	return status === "streaming"
		? {
				id,
				role: "assistant",
				content: [{type: "text", text}],
				model: {provider: "anthropic", id: "claude-sonnet"},
				timestamp,
				status,
			}
		: {
				id,
				role: "assistant",
				content: [{type: "text", text}],
				model: {provider: "anthropic", id: "claude-sonnet"},
				timestamp,
				status,
				stopReason: "stop",
			};
}

const toolCallingAssistant = (id: string, timestamp: number): StreamingAssistant => ({
	id,
	role: "assistant",
	content: [
		{
			type: "toolCall",
			toolCallId: `${id}-call`,
			toolName: "read",
			input: {},
		},
	],
	model: {provider: "anthropic", id: "claude-sonnet"},
	timestamp,
	status: "streaming",
});

const snapshot = (
	id: string,
	revision: number,
	transcript: SessionSnapshot["transcript"] = [user(`${id}-user`, "existing", 1)],
): SessionSnapshot => ({
	id,
	cwd: "/tmp/tuval",
	createdAt: 1,
	updatedAt: revision,
	phase: "idle",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	attached: true,
	locked: false,
	revision,
	transcript,
	queuedSteer: [],
	queuedSteerCount: 0,
});

class SyntheticPiProtocol {
	readonly commands: Array<string> = [];
	readonly detached: Array<string> = [];
	readonly snapshots = new Map<string, SessionSnapshot>();
	readonly locked = new Set<string>();
	readonly pendingPrompts = new Map<string, {id: string; sessionId: string; text: string}>();
	readonly eventsOnAttach = new Map<string, ReadonlyArray<ServerEvent>>();
	#handlers: ByteTransportHandlers | undefined;
	#closed = false;

	constructor(...sessions: Array<SessionSnapshot>) {
		for (const session of sessions) this.snapshots.set(session.id, session);
	}

	readonly factory: ByteTransportFactory = (handlers) => {
		this.#handlers = handlers;
		const decoder = new ClientMessageDecoder();
		return {
			send: async (chunk) => {
				for (const message of decoder.push(chunk)) this.#receive(message);
			},
			close: () => {
				if (this.#closed) return;
				this.#closed = true;
				handlers.onClose();
			},
		};
	};

	emit(event: ServerEvent): void {
		this.#deliver({type: "event", event});
	}

	acknowledgePrompt(correlation: string, next: SessionSnapshot): void {
		const pending = this.pendingPrompts.get(correlation);
		if (pending === undefined) throw new Error(`No pending prompt ${correlation}`);
		this.pendingPrompts.delete(correlation);
		this.snapshots.set(pending.sessionId, next);
		this.#deliver({
			type: "response",
			id: pending.id,
			ok: true,
			result: {command: "prompt", session: next},
		});
	}

	refusePrompt(correlation: string): void {
		const pending = this.pendingPrompts.get(correlation);
		if (pending === undefined) throw new Error(`No pending prompt ${correlation}`);
		this.pendingPrompts.delete(correlation);
		this.#deliver({
			type: "response",
			id: pending.id,
			ok: false,
			error: {code: "session_locked", message: "another controller owns the lease"},
		});
	}

	disconnect(): void {
		this.#handlers?.onClose();
	}

	emitMalformedEvent(): void {
		this.#handlers?.onData(
			encodeFrame(encodeCbor({type: "event", event: {type: "session_progress", sessionId: 42}})),
		);
	}

	#receive(message: ClientMessage): void {
		if (message.type === "hello") {
			this.#deliver({
				type: "hello",
				version: PROTOCOL_VERSION,
				connectionId: "synthetic-tuval",
				snapshot: {
					serverId: "synthetic",
					protocolVersion: PROTOCOL_VERSION,
					revision: 1,
					sessions: [...this.snapshots.values()].map((session) => ({
						id: session.id,
						createdAt: session.createdAt,
						updatedAt: session.updatedAt,
						cwd: session.cwd,
					})),
					models: [],
				},
			});
			return;
		}
		const command = message.request;
		this.commands.push(command.command);
		if (command.command === "attach") {
			const session = this.snapshots.get(command.sessionId);
			if (this.locked.has(command.sessionId)) {
				this.#deliver({
					type: "response",
					id: message.id,
					ok: false,
					error: {code: "session_locked", message: "session lease is owned elsewhere"},
				});
			} else if (session === undefined) {
				this.#deliver({
					type: "response",
					id: message.id,
					ok: false,
					error: {code: "not_found", message: "missing session"},
				});
			} else {
				this.#deliver({
					type: "response",
					id: message.id,
					ok: true,
					result: {command: "attach", session},
				});
				for (const event of this.eventsOnAttach.get(command.sessionId) ?? []) this.emit(event);
			}
			return;
		}
		if (command.command === "detach") {
			this.detached.push(command.sessionId);
			this.#deliver({
				type: "response",
				id: message.id,
				ok: true,
				result: {command: "detach", sessionId: command.sessionId},
			});
			return;
		}
		if (command.command === "prompt") {
			this.pendingPrompts.set(command.text, {
				id: message.id,
				sessionId: command.sessionId,
				text: command.text,
			});
			return;
		}
		throw new Error(`Unexpected synthetic command ${command.command}`);
	}

	#deliver(message: ServerMessage): void {
		this.#handlers?.onData(encodeServerMessage(message));
	}
}

const connect = (protocol: SyntheticPiProtocol) =>
	Effect.acquireRelease(PiLiveSession.connect(protocol.factory), (service) =>
		service.dispose().pipe(Effect.ignore),
	);

describe("PiLiveSession", () => {
	it.effect(
		"returns the existing transcript then reduces ordered live events without duplicate entries",
		() =>
			Effect.gen(function* () {
				const initial = snapshot("session-one", 1, [
					user("u1", "existing", 1),
					assistant("a1", "done", 2),
				]);
				const protocol = new SyntheticPiProtocol(initial);
				protocol.eventsOnAttach.set(initial.id, [
					{
						type: "session_progress",
						sessionId: initial.id,
						progress: {type: "item_started", item: assistant("a1", "duplicate", 2, "streaming")},
					},
					{
						type: "session_progress",
						sessionId: initial.id,
						progress: {type: "item_started", item: assistant("a2", "hel", 3, "streaming")},
					},
				]);
				const service = yield* connect(protocol);

				const attached = yield* service.attach(initial.id);
				assert.deepEqual(Schema.decodeUnknownSync(AttachLiveSessionOutcome)(attached), attached);
				assert.strictEqual(attached._tag, "attached");
				if (attached._tag !== "attached") return;
				assert.strictEqual(attached.session.phase, "idle");
				assert.deepEqual(attached.session.model, {
					provider: "anthropic",
					id: "claude-sonnet",
				});
				assert.strictEqual(attached.session.thinkingLevel, "high");
				assert.strictEqual(attached.session.ownership, "exclusive");
				assert.strictEqual(attached.session.connection, "connected");
				assert.strictEqual(attached.session.completion, "running");
				assert.deepEqual(
					attached._tag === "attached" && attached.session.transcript.map((item) => item.id),
					["u1", "a1", "a2"],
				);

				protocol.emit({
					type: "session_progress",
					sessionId: initial.id,
					progress: {
						type: "assistant_delta",
						messageId: "a2",
						contentIndex: 0,
						kind: "text",
						delta: "lo",
					},
				});
				protocol.emit({
					type: "session_progress",
					sessionId: initial.id,
					progress: {type: "item_finished", item: assistant("a2", "hello", 3)},
				});

				const current = yield* service.current();
				assert.deepEqual(Schema.decodeUnknownSync(LiveSessionView)(current), current);
				assert.deepEqual(
					current?.transcript.map((item) => item.id),
					["u1", "a1", "a2"],
				);
				assert.deepInclude(current?.transcript.at(-1), {
					id: "a2",
					content: [{type: "text", text: "hello"}],
					status: "complete",
				});
				const events = yield* service.eventsAfter();
				for (const event of events) {
					assert.deepEqual(Schema.decodeUnknownSync(LiveSessionEvent)(event), event);
				}
				const sequences = events.map((event) => event.sequence);
				assert.deepEqual(
					sequences,
					[...sequences].sort((a, b) => a - b),
				);
				yield* service.release();
				assert.deepEqual(protocol.detached, [initial.id]);
			}),
	);

	it.effect("correlates prompts and streams progress before protocol acknowledgement", () =>
		Effect.gen(function* () {
			const initial = snapshot("session-prompt", 1);
			const protocol = new SyntheticPiProtocol(initial);
			const service = yield* connect(protocol);
			const attached = yield* service.attach(initial.id);
			const afterSequence = attached._tag === "attached" ? attached.session.lastEventSequence : 0;
			const streamed = yield* service
				.events(afterSequence)
				.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
			const pending = yield* service
				.prompt({correlationId: "prompt-1", text: "say hello"})
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			assert.isUndefined(pending.pollUnsafe());

			protocol.emit({
				type: "session_progress",
				sessionId: initial.id,
				progress: {type: "item_started", item: assistant("streamed", "hello", 2, "streaming")},
			});
			const streamedEvents = Array.from(yield* Fiber.join(streamed));
			assert.lengthOf(streamedEvents, 1);
			assert.deepInclude(streamedEvents[0], {_tag: "session"});
			assert.strictEqual((yield* service.current())?.transcript.at(-1)?.id, "streamed");
			assert.isUndefined(pending.pollUnsafe());

			const acknowledged = snapshot("session-prompt", 2, [
				...initial.transcript,
				assistant("streamed", "hello", 2),
			]);
			protocol.acknowledgePrompt("say hello", acknowledged);
			const promptOutcome = yield* Fiber.join(pending);
			assert.strictEqual(promptOutcome._tag, "acknowledged");
			assert.strictEqual(promptOutcome.correlationId, "prompt-1");
			const promptEvent = (yield* service.eventsAfter()).find((event) => event._tag === "prompt");
			assert.strictEqual(promptEvent?._tag, "prompt");
			if (promptEvent?._tag !== "prompt") return;
			assert.strictEqual(promptEvent.outcome._tag, "acknowledged");
			assert.strictEqual(promptEvent.outcome.correlationId, "prompt-1");

			const refused = yield* service
				.prompt({correlationId: "prompt-2", text: "blocked"})
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			protocol.refusePrompt("blocked");
			assert.deepInclude(yield* Fiber.join(refused), {
				_tag: "refused",
				correlationId: "prompt-2",
				code: "lease-refused",
			});
		}),
	);

	it.effect("scopes prompt correlation to one attachment and publishes reuse refusals", () =>
		Effect.gen(function* () {
			const first = snapshot("correlation-first", 1);
			const second = snapshot("correlation-second", 1);
			const protocol = new SyntheticPiProtocol(first, second);
			const service = yield* connect(protocol);
			yield* service.attach(first.id);

			const firstPrompt = yield* service
				.prompt({correlationId: "shared-correlation", text: "same text"})
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			protocol.acknowledgePrompt("same text", snapshot(first.id, 2));
			assert.deepInclude(yield* Fiber.join(firstPrompt), {
				_tag: "acknowledged",
				correlationId: "shared-correlation",
			});

			const beforeReuse = (yield* service.eventsAfter()).at(-1)?.sequence ?? 0;
			assert.deepInclude(
				yield* service.prompt({correlationId: "shared-correlation", text: "different text"}),
				{
					_tag: "refused",
					correlationId: "shared-correlation",
					code: "protocol",
				},
			);
			const reuseEvents = yield* service.eventsAfter(beforeReuse);
			assert.lengthOf(reuseEvents, 1);
			const reuseEvent = reuseEvents[0];
			assert.strictEqual(reuseEvent?._tag, "prompt");
			if (reuseEvent?._tag !== "prompt") return;
			assert.deepInclude(reuseEvent.outcome, {
				_tag: "refused",
				correlationId: "shared-correlation",
				code: "protocol",
			});

			yield* service.attach(second.id);
			const secondPrompt = yield* service
				.prompt({correlationId: "shared-correlation", text: "same text"})
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			assert.isUndefined(secondPrompt.pollUnsafe());
			protocol.acknowledgePrompt("same text", snapshot(second.id, 2));
			const secondOutcome = yield* Fiber.join(secondPrompt);
			assert.strictEqual(secondOutcome._tag, "acknowledged");
			if (secondOutcome._tag !== "acknowledged") return;
			assert.strictEqual(secondOutcome.session.sessionId, second.id);
			assert.lengthOf(
				protocol.commands.filter((command) => command === "prompt"),
				2,
			);
		}),
	);

	it.effect(
		"replaces attachments by cleaning the prior subscription and lease before attaching the next",
		() =>
			Effect.gen(function* () {
				const first = snapshot("first", 1);
				const second = snapshot("second", 1);
				const protocol = new SyntheticPiProtocol(first, second);
				const service = yield* connect(protocol);
				yield* service.attach(first.id);
				yield* service.attach(second.id);

				assert.deepEqual(protocol.commands, ["attach", "detach", "attach"]);
				assert.deepEqual(protocol.detached, [first.id]);
				protocol.emit({
					type: "session_progress",
					sessionId: first.id,
					progress: {type: "item_started", item: user("late-first", "ignored", 5)},
				});
				const current = yield* service.current();
				assert.strictEqual(current?.sessionId, second.id);
				assert.notInclude(current?.transcript.map((item) => item.id) ?? [], "late-first");

				yield* service.release();
				assert.deepEqual(protocol.detached, [first.id, second.id]);
				assert.isNull(yield* service.current());
			}),
	);

	it.effect("reports lease refusal and protocol-sourced disconnected state", () =>
		Effect.gen(function* () {
			const refusedSession = snapshot("locked", 1);
			const live = snapshot("live", 1);
			const protocol = new SyntheticPiProtocol(refusedSession, live);
			protocol.locked.add(refusedSession.id);
			const service = yield* connect(protocol);

			assert.deepInclude(yield* service.attach(refusedSession.id), {
				_tag: "refused",
				code: "lease-refused",
			});
			yield* service.attach(live.id);
			protocol.disconnect();

			const disconnected = yield* service.current();
			assert.deepInclude(disconnected, {
				_tag: "disconnected",
				connection: "disconnected",
				ownership: "none",
				completion: "disconnected",
			});
			assert.strictEqual(disconnected?.transcript[0]?.id, "live-user");
			assert.deepInclude(yield* service.prompt({correlationId: "after-disconnect", text: "no"}), {
				_tag: "refused",
				code: "disconnected",
			});
		}),
	);

	it.effect("releases the selected lease when the protocol removes the session", () =>
		Effect.gen(function* () {
			const live = snapshot("removed", 1);
			const protocol = new SyntheticPiProtocol(live);
			const service = yield* connect(protocol);
			yield* service.attach(live.id);

			protocol.emit({type: "session_removed", sessionId: live.id});
			assert.deepInclude(yield* service.current(), {
				_tag: "disconnected",
				ownership: "none",
				completion: "disconnected",
			});
			const reattached = yield* service.attach(live.id);
			assert.deepInclude(reattached, {_tag: "attached"});
			assert.deepEqual(protocol.commands, ["attach", "attach"]);

			protocol.emit({
				type: "session_progress",
				sessionId: live.id,
				progress: {type: "item_started", item: user("after-reattach", "accepted", 2)},
			});
			assert.include(
				(yield* service.current())?.transcript.map((item) => item.id) ?? [],
				"after-reattach",
			);
		}),
	);

	it.effect("diagnoses every incoherent assistant delta without publishing session state", () =>
		Effect.gen(function* () {
			const live = snapshot("incoherent-deltas", 1, [
				user("user-target", "existing", 1),
				assistant("text-target", "hello", 2, "streaming"),
				toolCallingAssistant("tool-target", 3),
			]);
			const protocol = new SyntheticPiProtocol(live);
			const service = yield* connect(protocol);
			const attached = yield* service.attach(live.id);
			const afterSequence = attached._tag === "attached" ? attached.session.lastEventSequence : 0;
			const deltas: ReadonlyArray<ServerEvent> = [
				{
					type: "session_progress",
					sessionId: live.id,
					progress: {
						type: "assistant_delta",
						messageId: "missing-target",
						contentIndex: 0,
						kind: "text",
						delta: "!",
					},
				},
				{
					type: "session_progress",
					sessionId: live.id,
					progress: {
						type: "assistant_delta",
						messageId: "user-target",
						contentIndex: 0,
						kind: "text",
						delta: "!",
					},
				},
				{
					type: "session_progress",
					sessionId: live.id,
					progress: {
						type: "assistant_delta",
						messageId: "text-target",
						contentIndex: 1,
						kind: "text",
						delta: "!",
					},
				},
				{
					type: "session_progress",
					sessionId: live.id,
					progress: {
						type: "assistant_delta",
						messageId: "text-target",
						contentIndex: 0,
						kind: "thinking",
						delta: "!",
					},
				},
				{
					type: "session_progress",
					sessionId: live.id,
					progress: {
						type: "assistant_delta",
						messageId: "tool-target",
						contentIndex: 0,
						kind: "toolCall",
						delta: "!",
					},
				},
			];

			for (const delta of deltas) protocol.emit(delta);

			const events = yield* service.eventsAfter(afterSequence);
			assert.lengthOf(events, deltas.length);
			assert.isTrue(events.every((event) => event._tag === "diagnostic"));
			assert.isFalse(events.some((event) => event._tag === "session"));
			const messages = events.flatMap((event) =>
				event._tag === "diagnostic" ? [event.message] : [],
			);
			assert.isTrue(messages.some((message) => /missing-target/.test(message)));
			assert.isTrue(messages.some((message) => /user-target/.test(message)));
			assert.isTrue(messages.some((message) => /content index 1/i.test(message)));
			assert.isTrue(messages.some((message) => /thinking.*text/i.test(message)));
			assert.isTrue(messages.some((message) => /toolCall/i.test(message)));
			assert.deepEqual(
				(yield* service.current())?.transcript,
				live.transcript.map((item) => ({
					id: item.id,
					role: item.role,
					content: [...item.content],
					timestamp: item.timestamp,
					status: item.role === "user" ? "complete" : item.status,
				})),
			);
		}),
	);

	it.effect("isolates a malformed protocol event and emits an actionable diagnostic", () =>
		Effect.gen(function* () {
			const live = snapshot("malformed", 1);
			const protocol = new SyntheticPiProtocol(live);
			const service = yield* connect(protocol);
			yield* service.attach(live.id);

			protocol.emitMalformedEvent();

			const malformed = yield* service.current();
			assert.deepInclude(malformed, {_tag: "disconnected"});
			assert.strictEqual(malformed?.transcript[0]?.id, "malformed-user");
			assert.isTrue(
				(yield* service.eventsAfter()).some(
					(event) => event._tag === "diagnostic" && /session_progress|invalid/i.test(event.message),
				),
			);
		}),
	);
});
