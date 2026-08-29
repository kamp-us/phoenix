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
import * as TestClock from "effect/testing/TestClock";
import {
	type LiveSessionStateOptions,
	makeDurableLiveSession,
	makeResilientPiLiveSession,
	PiLiveSession,
} from "../src/backend/live-session.js";
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
		const pending = this.#takePendingPrompt(correlation, next);
		this.#deliver({
			type: "response",
			id: pending.id,
			ok: true,
			result: {command: "prompt", session: next},
		});
	}

	acknowledgePromptThenRemove(correlation: string, next: SessionSnapshot): void {
		const pending = this.#takePendingPrompt(correlation, next);
		this.#deliverTogether(
			{
				type: "response",
				id: pending.id,
				ok: true,
				result: {command: "prompt", session: next},
			},
			{type: "event", event: {type: "session_removed", sessionId: pending.sessionId}},
		);
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

	#takePendingPrompt(
		correlation: string,
		next: SessionSnapshot,
	): {id: string; sessionId: string; text: string} {
		const pending = this.pendingPrompts.get(correlation);
		if (pending === undefined) throw new Error(`No pending prompt ${correlation}`);
		this.pendingPrompts.delete(correlation);
		this.snapshots.set(pending.sessionId, next);
		return pending;
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
		if (command.command === "create") {
			const created = snapshot("created-by-checkpoint", 1);
			this.snapshots.set(created.id, created);
			this.#deliver({
				type: "response",
				id: message.id,
				ok: true,
				result: {command: "create", session: created},
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

	#deliverTogether(...messages: ReadonlyArray<ServerMessage>): void {
		const frames = messages.map((message) => encodeServerMessage(message));
		const chunk = new Uint8Array(frames.reduce((length, frame) => length + frame.length, 0));
		let offset = 0;
		for (const frame of frames) {
			chunk.set(frame, offset);
			offset += frame.length;
		}
		this.#handlers?.onData(chunk);
	}
}

const connect = (protocol: SyntheticPiProtocol, options: LiveSessionStateOptions = {}) =>
	Effect.acquireRelease(PiLiveSession.connect(protocol.factory, options), (service) =>
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

	it.effect("keeps release invisible and attached when its checkpoint is refused", () =>
		Effect.gen(function* () {
			const initial = snapshot("release-persistence", 1);
			const protocol = new SyntheticPiProtocol(initial);
			const raw = yield* connect(protocol);
			assert.strictEqual((yield* raw.attach(initial.id))._tag, "attached");
			let checkpoints = 0;
			const durable = makeDurableLiveSession(raw, (_candidateSessionId, _commit) =>
				Effect.sync(() => {
					checkpoints += 1;
					return false;
				}),
			);

			const outcome = yield* durable.release();

			assert.deepInclude(outcome, {
				_tag: "failed",
				sessionId: initial.id,
				code: "persistence",
			});
			assert.strictEqual(checkpoints, 1);
			assert.deepStrictEqual(protocol.detached, []);
			assert.deepInclude(yield* durable.current(), {sessionId: initial.id});
		}),
	);

	it.effect("keeps attach, create, and open invisible when each checkpoint is refused", () =>
		Effect.gen(function* () {
			const first = snapshot("checkpoint-first", 1);
			const second = snapshot("checkpoint-second", 1);
			const refused = (_candidateSessionId: string | null, _commit: () => void) =>
				Effect.succeed(false);

			const attachProtocol = new SyntheticPiProtocol(first);
			const attach = makeDurableLiveSession(yield* connect(attachProtocol), refused);
			assert.deepInclude(yield* attach.attach(first.id), {
				_tag: "refused",
				code: "persistence",
			});
			assert.isNull(yield* attach.current());
			assert.deepStrictEqual(attachProtocol.detached, [first.id]);

			const createProtocol = new SyntheticPiProtocol(first);
			const createRaw = yield* connect(createProtocol);
			yield* createRaw.attach(first.id);
			const create = makeDurableLiveSession(createRaw, refused);
			assert.deepInclude(yield* create.create({correlationId: "checkpoint-create"}), {
				_tag: "refused",
				command: "create",
				code: "persistence",
			});
			assert.strictEqual((yield* create.current())?.sessionId, first.id);
			assert.include(createProtocol.commands, "create");

			const openProtocol = new SyntheticPiProtocol(first, second);
			const openRaw = yield* connect(openProtocol);
			yield* openRaw.attach(first.id);
			const open = makeDurableLiveSession(openRaw, refused);
			assert.deepInclude(
				yield* open.open({correlationId: "checkpoint-open", sessionId: second.id}),
				{_tag: "refused", command: "open", code: "persistence"},
			);
			assert.strictEqual((yield* open.current())?.sessionId, first.id);
			assert.deepStrictEqual(openProtocol.detached, [second.id]);
		}),
	);

	it.effect("publishes successful selection commits only from inside the durable checkpoint", () =>
		Effect.gen(function* () {
			const first = snapshot("checkpoint-order-first", 1);
			const second = snapshot("checkpoint-order-second", 1);
			const protocol = new SyntheticPiProtocol(first, second);
			const raw = yield* connect(protocol);
			yield* raw.attach(first.id);
			const observations: Array<{
				candidate: string | null;
				before: string | null;
				after: string | null;
			}> = [];
			const durable = makeDurableLiveSession(raw, (candidate, commit) =>
				Effect.gen(function* () {
					const before = (yield* raw.current())?.sessionId ?? null;
					commit();
					const after = (yield* raw.current())?.sessionId ?? null;
					observations.push({candidate, before, after});
					return true;
				}),
			);

			assert.strictEqual((yield* durable.attach(second.id))._tag, "attached");
			assert.deepStrictEqual(observations[0], {
				candidate: second.id,
				before: first.id,
				after: second.id,
			});
			assert.strictEqual((yield* durable.release())._tag, "released");
			assert.deepStrictEqual(observations[1], {
				candidate: null,
				before: second.id,
				after: null,
			});
		}),
	);

	it.effect("lets a newer attach-boundary snapshot supersede earlier buffered progress", () =>
		Effect.gen(function* () {
			const initial = snapshot("snapshot-order", 1);
			const authoritative = snapshot(initial.id, 2, [
				user("authoritative-user", "snapshot wins", 2),
			]);
			const protocol = new SyntheticPiProtocol(initial);
			protocol.eventsOnAttach.set(initial.id, [
				{
					type: "session_progress",
					sessionId: initial.id,
					progress: {
						type: "item_started",
						item: assistant("before-snapshot", "superseded", 2, "streaming"),
					},
				},
				{type: "session_snapshot", snapshot: authoritative},
				{
					type: "session_progress",
					sessionId: initial.id,
					progress: {
						type: "item_started",
						item: assistant("after-snapshot", "retained", 3, "streaming"),
					},
				},
			]);
			const service = yield* connect(protocol);

			const attached = yield* service.attach(initial.id);
			assert.strictEqual(attached._tag, "attached");
			if (attached._tag !== "attached") return;
			assert.strictEqual(attached.session.revision, authoritative.revision);
			assert.deepEqual(
				attached.session.transcript.map((item) => item.id),
				["authoritative-user", "after-snapshot"],
			);
			const sessionEvents = (yield* service.eventsAfter()).flatMap((event) =>
				event._tag === "session" ? [event.session] : [],
			);
			assert.isTrue(sessionEvents.length > 0);
			assert.isTrue(
				sessionEvents.every((session) =>
					session.transcript.every((item) => item.id !== "before-snapshot"),
				),
			);
		}),
	);

	it.effect("settles prompt projections before acknowledgement can win event order", () =>
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
			assert.isFalse((yield* service.current())?.controls?.create ?? true);
			assert.isFalse((yield* service.current())?.controls?.open ?? true);

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
			const events = yield* service.eventsAfter(afterSequence);
			const promptEvent = events.find((event) => event._tag === "prompt");
			const restoredEvent = events.findLast((event) => event._tag === "session");
			assert.strictEqual(promptEvent?._tag, "prompt");
			assert.strictEqual(restoredEvent?._tag, "session");
			if (
				promptOutcome._tag !== "acknowledged" ||
				promptEvent?._tag !== "prompt" ||
				promptEvent.outcome._tag !== "acknowledged" ||
				restoredEvent?._tag !== "session"
			) {
				return;
			}
			assert.isTrue(restoredEvent.session.controls?.create ?? false);
			assert.isTrue(restoredEvent.session.controls?.open ?? false);
			assert.deepEqual(promptOutcome.session, restoredEvent.session);
			assert.deepEqual(promptEvent.outcome.session, restoredEvent.session);
			assert.isAbove(promptEvent.sequence, restoredEvent.sequence);
			assert.strictEqual(promptEvent.outcome.session.lastEventSequence, restoredEvent.sequence);

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

	it.effect(
		"times out prompt acknowledgement, ignores the late response, and retries freshly",
		() =>
			Effect.gen(function* () {
				const initial = snapshot("prompt-timeout", 1);
				const protocol = new SyntheticPiProtocol(initial);
				let expire = () => {};
				const service = yield* connect(protocol, {
					acknowledgementTimeoutMs: 25,
					makeAcknowledgementDeadline: () => ({
						elapsed: new Promise<void>((resolve) => {
							expire = resolve;
						}),
						cancel: () => {},
					}),
				});
				yield* service.attach(initial.id);
				const timedOut = yield* service
					.prompt({correlationId: "bounded-prompt", text: "first delivery"})
					.pipe(Effect.forkChild);
				yield* Effect.yieldNow;
				expire();
				assert.deepInclude(yield* Fiber.join(timedOut), {
					_tag: "refused",
					correlationId: "bounded-prompt",
					code: "protocol",
				});

				protocol.acknowledgePrompt("first delivery", snapshot(initial.id, 2));
				assert.isTrue((yield* service.current())?.connection === "connected");
				for (let index = 0; index < 101; index += 1) {
					const exhausted = yield* service
						.prompt({correlationId: `expired-${index}`, text: `expired delivery ${index}`})
						.pipe(Effect.forkChild);
					yield* Effect.yieldNow;
					expire();
					assert.deepInclude(yield* Fiber.join(exhausted), {_tag: "refused", code: "protocol"});
				}
				const retry = yield* service
					.prompt({correlationId: "bounded-prompt", text: "fresh delivery"})
					.pipe(Effect.forkChild);
				yield* Effect.yieldNow;
				protocol.acknowledgePrompt("fresh delivery", snapshot(initial.id, 3));
				assert.strictEqual((yield* Fiber.join(retry))._tag, "acknowledged");
				assert.lengthOf(
					protocol.commands.filter((command) => command === "prompt"),
					103,
				);
			}),
	);

	it.effect("cancels the exact Pi prompt request when its Effect is interrupted", () =>
		Effect.gen(function* () {
			const initial = snapshot("prompt-interruption", 1);
			const protocol = new SyntheticPiProtocol(initial);
			const service = yield* connect(protocol, {acknowledgementTimeoutMs: 60_000});
			yield* service.attach(initial.id);
			const interrupted = yield* service
				.prompt({correlationId: "interrupted-prompt", text: "cancel me"})
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(interrupted);
			yield* Effect.yieldNow;
			protocol.acknowledgePrompt("cancel me", snapshot(initial.id, 2));
			const retry = yield* service
				.prompt({correlationId: "interrupted-prompt", text: "retry me"})
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			protocol.acknowledgePrompt("retry me", snapshot(initial.id, 3));
			assert.strictEqual((yield* Fiber.join(retry))._tag, "acknowledged");
			assert.lengthOf(
				protocol.commands.filter((command) => command === "prompt"),
				2,
			);
		}),
	);

	it.effect("replays only current session state to a fresh subscriber, never prompt outcomes", () =>
		Effect.gen(function* () {
			const initial = snapshot("fresh-subscriber", 1);
			const protocol = new SyntheticPiProtocol(initial);
			const service = yield* connect(protocol);
			yield* service.attach(initial.id);
			const pending = yield* service
				.prompt({correlationId: "private-correlation", text: "private prompt"})
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			protocol.acknowledgePrompt("private prompt", snapshot(initial.id, 2));
			yield* Fiber.join(pending);

			const replay = Array.from(yield* service.events().pipe(Stream.take(1), Stream.runCollect));
			assert.lengthOf(replay, 1);
			assert.strictEqual(replay[0]?._tag, "session");
			assert.notInclude(JSON.stringify(replay), "private-correlation");
			assert.notInclude(JSON.stringify(replay), "private prompt");
			const history = yield* service.eventsAfter(0);
			const resumed = Array.from(
				yield* service.events(0).pipe(Stream.take(history.length), Stream.runCollect),
			);
			assert.isTrue(resumed.some((event) => event._tag === "prompt"));
			yield* service.release();
			const afterRelease = yield* service
				.events()
				.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
			yield* Effect.yieldNow;
			assert.isUndefined(afterRelease.pollUnsafe());
			yield* Fiber.interrupt(afterRelease);
		}),
	);

	it.effect("refuses acknowledgement when the same delivery removes the prompted session", () =>
		Effect.gen(function* () {
			const initial = snapshot("prompt-removed", 1);
			const protocol = new SyntheticPiProtocol(initial);
			const service = yield* connect(protocol);
			yield* service.attach(initial.id);
			const pending = yield* service
				.prompt({correlationId: "removed-prompt", text: "remove after response"})
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;

			protocol.acknowledgePromptThenRemove("remove after response", snapshot(initial.id, 2));

			assert.deepInclude(yield* Fiber.join(pending), {
				_tag: "refused",
				correlationId: "removed-prompt",
				code: "disconnected",
			});
			assert.deepInclude(yield* service.current(), {
				_tag: "disconnected",
				connection: "disconnected",
				ownership: "none",
			});
			const promptEvent = (yield* service.eventsAfter()).findLast(
				(event) => event._tag === "prompt",
			);
			assert.strictEqual(promptEvent?._tag, "prompt");
			if (promptEvent?._tag !== "prompt") return;
			assert.deepInclude(promptEvent.outcome, {
				_tag: "refused",
				correlationId: "removed-prompt",
				code: "disconnected",
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

				assert.deepEqual(protocol.commands, ["attach", "attach", "detach"]);
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

	it.effect(
		"reconnects with a fresh lease without replaying acknowledged prompts or controls",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const initial = snapshot("reconnect-selection", 1);
					const protocol = new SyntheticPiProtocol(initial);
					const subscriptions: Array<string> = [];
					const service = yield* makeResilientPiLiveSession(protocol.factory, {
						retries: 0,
						baseDelayMs: 1,
						maxDelayMs: 1,
						onSessionSubscriptionBound: (sessionId) => subscriptions.push(sessionId),
					});
					yield* service.attach(initial.id);
					const prompt = yield* service
						.prompt({correlationId: "before-reconnect", text: "exactly once"})
						.pipe(Effect.forkChild);
					yield* Effect.yieldNow;
					protocol.acknowledgePrompt("exactly once", snapshot(initial.id, 2));
					assert.strictEqual((yield* Fiber.join(prompt))._tag, "acknowledged");

					protocol.disconnect();
					for (let attempt = 0; attempt < 20; attempt += 1) {
						if (protocol.commands.filter((command) => command === "attach").length === 2) {
							break;
						}
						yield* Effect.yieldNow;
					}

					assert.lengthOf(
						protocol.commands.filter((command) => command === "attach"),
						2,
					);
					assert.lengthOf(
						protocol.commands.filter((command) => command === "prompt"),
						1,
					);
					assert.deepStrictEqual(subscriptions, [initial.id, initial.id]);
					assert.deepInclude(yield* service.current(), {
						_tag: "attached",
						sessionId: initial.id,
					});
				}),
			),
	);

	it.effect(
		"rearms after an exhausted reconnect cycle and subscribes exactly once on recovery",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const initial = snapshot("delayed-recovery", 1);
					const protocol = new SyntheticPiProtocol(initial);
					let connections = 0;
					const factory: ByteTransportFactory = (handlers) => {
						connections += 1;
						if (connections === 2 || connections === 3) {
							return Promise.reject(new Error("transport delayed"));
						}
						return protocol.factory(handlers);
					};
					const subscriptions: Array<string> = [];
					const service = yield* makeResilientPiLiveSession(factory, {
						retries: 0,
						baseDelayMs: 1,
						maxDelayMs: 1,
						rearmDelayMs: 2,
						onSessionSubscriptionBound: (sessionId) => subscriptions.push(sessionId),
					});
					yield* service.attach(initial.id);
					protocol.disconnect();
					for (let attempt = 0; attempt < 100 && connections < 4; attempt += 1) {
						yield* TestClock.adjust("2 millis");
					}
					assert.strictEqual(connections, 4);
					assert.deepStrictEqual(subscriptions, [initial.id, initial.id]);
					assert.lengthOf(
						protocol.commands.filter((command) => command === "attach"),
						2,
					);
					assert.deepInclude(yield* service.current(), {
						_tag: "attached",
						sessionId: initial.id,
					});
				}),
			),
	);

	it.effect("does not replay stale state when reconnect selection is unavailable", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const initial = snapshot("stale-reconnect-selection", 1);
				const first = new SyntheticPiProtocol(initial);
				const second = new SyntheticPiProtocol(initial);
				const third = new SyntheticPiProtocol(snapshot(initial.id, 2));
				second.locked.add(initial.id);
				let connections = 0;
				const factory: ByteTransportFactory = (handlers) => {
					connections += 1;
					return (connections === 1 ? first : connections === 2 ? second : third).factory(handlers);
				};
				const service = yield* makeResilientPiLiveSession(factory, {retries: 0});
				yield* service.attach(initial.id);
				first.disconnect();
				for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
				assert.strictEqual(connections, 2);
				assert.isNull(yield* service.current());
				assert.strictEqual(yield* service.selectionIntent(), initial.id);
				const fresh = yield* service
					.events()
					.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
				yield* Effect.yieldNow;
				assert.isUndefined(fresh.pollUnsafe());
				yield* Fiber.interrupt(fresh);
				second.disconnect();
				let restored = yield* service.current();
				for (let attempt = 0; attempt < 50; attempt += 1) {
					yield* Effect.yieldNow;
					restored = yield* service.current();
					if (restored?.sessionId === initial.id) break;
				}
				assert.strictEqual(connections, 3);
				assert.deepInclude(restored, {
					_tag: "attached",
					sessionId: initial.id,
					revision: 2,
				});
				assert.strictEqual(yield* service.selectionIntent(), initial.id);
				assert.deepInclude(yield* service.release(), {_tag: "released"});
				assert.isNull(yield* service.selectionIntent());
			}),
		),
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

	it.effect("reduces partial and complete streamed tool-call arguments", () =>
		Effect.gen(function* () {
			const live = snapshot("tool-call-deltas", 1, [toolCallingAssistant("tool-target", 1)]);
			const protocol = new SyntheticPiProtocol(live);
			const service = yield* connect(protocol);
			const attached = yield* service.attach(live.id);
			const afterSequence = attached._tag === "attached" ? attached.session.lastEventSequence : 0;

			protocol.emit({
				type: "session_progress",
				sessionId: live.id,
				progress: {
					type: "assistant_delta",
					messageId: "tool-target",
					contentIndex: 0,
					kind: "toolCall",
					delta: '{"path":',
				},
			});
			assert.deepInclude((yield* service.current())?.transcript[0]?.content[0], {
				type: "toolCall",
				input: '{"path":',
			});

			protocol.emit({
				type: "session_progress",
				sessionId: live.id,
				progress: {type: "item_updated", item: toolCallingAssistant("tool-target", 1)},
			});
			protocol.emit({
				type: "session_progress",
				sessionId: live.id,
				progress: {
					type: "assistant_delta",
					messageId: "tool-target",
					contentIndex: 0,
					kind: "toolCall",
					delta: '"README.md"}',
				},
			});

			assert.deepInclude((yield* service.current())?.transcript[0]?.content[0], {
				type: "toolCall",
				input: {path: "README.md"},
			});
			const events = yield* service.eventsAfter(afterSequence);
			assert.lengthOf(events, 3);
			assert.isTrue(events.every((event) => event._tag === "session"));
		}),
	);

	it.effect("diagnoses every incoherent assistant delta without publishing session state", () =>
		Effect.gen(function* () {
			const live = snapshot("incoherent-deltas", 1, [
				user("user-target", "existing", 1),
				assistant("text-target", "hello", 2, "streaming"),
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
