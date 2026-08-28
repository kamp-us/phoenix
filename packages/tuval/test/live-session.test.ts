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
import {Schema} from "effect";
import {afterEach, describe, expect, it} from "vitest";
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

const services: Array<PiLiveSession> = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose()));
});

const connect = async (protocol: SyntheticPiProtocol): Promise<PiLiveSession> => {
	const service = await PiLiveSession.connect(protocol.factory);
	services.push(service);
	return service;
};

describe("PiLiveSession", () => {
	it("returns the existing transcript then reduces ordered live events without duplicate entries", async () => {
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
		const service = await connect(protocol);

		const attached = await service.attach(initial.id);
		expect(Schema.decodeUnknownSync(AttachLiveSessionOutcome)(attached)).toEqual(attached);
		expect(attached).toMatchObject({
			_tag: "attached",
			session: {
				phase: "idle",
				model: {provider: "anthropic", id: "claude-sonnet"},
				thinkingLevel: "high",
				ownership: "exclusive",
				connection: "connected",
				completion: "running",
			},
		});

		expect(
			attached._tag === "attached" && attached.session.transcript.map((item) => item.id),
		).toEqual(["u1", "a1", "a2"]);
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

		const current = service.current();
		expect(Schema.decodeUnknownSync(LiveSessionView)(current)).toEqual(current);
		expect(current?.transcript.map((item) => item.id)).toEqual(["u1", "a1", "a2"]);
		expect(current?.transcript.at(-1)).toMatchObject({
			id: "a2",
			content: [{type: "text", text: "hello"}],
			status: "complete",
		});
		const events = service.eventsAfter();
		for (const event of events) {
			expect(Schema.decodeUnknownSync(LiveSessionEvent)(event)).toEqual(event);
		}
		const sequences = events.map((event) => event.sequence);
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		await service.release();
		expect(protocol.detached).toEqual([initial.id]);
	});

	it("correlates prompts, streams progress while pending, and acknowledges only after the result", async () => {
		const initial = snapshot("session-prompt", 1);
		const protocol = new SyntheticPiProtocol(initial);
		const service = await connect(protocol);
		await service.attach(initial.id);
		const streamedEvents: Array<string> = [];
		service.subscribe((event) => streamedEvents.push(event._tag));

		let settled = false;
		const pending = service.prompt({correlationId: "prompt-1", text: "say hello"}).then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		protocol.emit({
			type: "session_progress",
			sessionId: initial.id,
			progress: {type: "item_started", item: assistant("streamed", "hello", 2, "streaming")},
		});
		expect(service.current()?.transcript.at(-1)?.id).toBe("streamed");
		expect(streamedEvents).toEqual(["session"]);
		expect(settled).toBe(false);

		const acknowledged = snapshot("session-prompt", 2, [
			...initial.transcript,
			assistant("streamed", "hello", 2),
		]);
		protocol.acknowledgePrompt("say hello", acknowledged);
		await expect(pending).resolves.toMatchObject({
			_tag: "acknowledged",
			correlationId: "prompt-1",
		});
		expect(service.eventsAfter().find((event) => event._tag === "prompt")).toMatchObject({
			outcome: {_tag: "acknowledged", correlationId: "prompt-1"},
		});

		const refused = service.prompt({correlationId: "prompt-2", text: "blocked"});
		await Promise.resolve();
		protocol.refusePrompt("blocked");
		await expect(refused).resolves.toMatchObject({
			_tag: "refused",
			correlationId: "prompt-2",
			code: "lease-refused",
		});
	});

	it("replaces attachments by cleaning the prior subscription and lease before attaching the next", async () => {
		const first = snapshot("first", 1);
		const second = snapshot("second", 1);
		const protocol = new SyntheticPiProtocol(first, second);
		const service = await connect(protocol);
		await service.attach(first.id);
		await service.attach(second.id);

		expect(protocol.commands).toEqual(["attach", "detach", "attach"]);
		expect(protocol.detached).toEqual([first.id]);
		protocol.emit({
			type: "session_progress",
			sessionId: first.id,
			progress: {type: "item_started", item: user("late-first", "ignored", 5)},
		});
		expect(service.current()?.sessionId).toBe(second.id);
		expect(service.current()?.transcript.map((item) => item.id)).not.toContain("late-first");

		await service.release();
		expect(protocol.detached).toEqual([first.id, second.id]);
		expect(service.current()).toBeNull();
	});

	it("reports lease refusal and preserves the last validated transcript on disconnect", async () => {
		const refusedSession = snapshot("locked", 1);
		const live = snapshot("live", 1);
		const protocol = new SyntheticPiProtocol(refusedSession, live);
		protocol.locked.add(refusedSession.id);
		const service = await connect(protocol);

		await expect(service.attach(refusedSession.id)).resolves.toMatchObject({
			_tag: "refused",
			code: "lease-refused",
		});
		await service.attach(live.id);
		protocol.disconnect();

		expect(service.current()).toMatchObject({
			_tag: "disconnected",
			connection: "disconnected",
			ownership: "none",
			completion: "disconnected",
			transcript: [{id: "live-user"}],
		});
		await expect(
			service.prompt({correlationId: "after-disconnect", text: "no"}),
		).resolves.toMatchObject({_tag: "refused", code: "disconnected"});
	});

	it("isolates a malformed protocol event and emits an actionable diagnostic", async () => {
		const live = snapshot("malformed", 1);
		const protocol = new SyntheticPiProtocol(live);
		const service = await connect(protocol);
		await service.attach(live.id);

		protocol.emitMalformedEvent();

		expect(service.current()).toMatchObject({
			_tag: "disconnected",
			transcript: [{id: "malformed-user"}],
		});
		expect(
			service
				.eventsAfter()
				.some(
					(event) => event._tag === "diagnostic" && /session_progress|invalid/i.test(event.message),
				),
		).toBe(true);
	});
});
