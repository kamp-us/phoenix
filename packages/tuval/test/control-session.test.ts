import type {ByteTransportFactory, ByteTransportHandlers} from "@earendil-works/pi-client";
import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
	type ModelMetadata,
	PROTOCOL_VERSION,
	type ServerMessage,
	type SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Schema} from "effect";
import {type AcknowledgementDeadline, PiLiveSession} from "../src/backend/live-session.js";
import {ControlLiveSessionOutcome} from "../src/shared/live-session.js";

const model = (
	id: string,
	supportedThinkingLevels: ModelMetadata["supportedThinkingLevels"],
): ModelMetadata => ({
	provider: "synthetic",
	id,
	name: id,
	api: "synthetic",
	reasoning: supportedThinkingLevels.some((level) => level !== "off"),
	input: ["text"],
	contextWindow: 10_000,
	maxTokens: 1_000,
	cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
	supportedThinkingLevels,
	authenticated: true,
});

const snapshot = (
	id: string,
	revision = 1,
	options: Partial<Pick<SessionSnapshot, "phase" | "model" | "thinkingLevel">> = {},
): SessionSnapshot => ({
	id,
	cwd: "/tmp/tuval",
	createdAt: 1,
	updatedAt: revision,
	phase: options.phase ?? "idle",
	model: options.model ?? {provider: "synthetic", id: "small"},
	thinkingLevel: options.thinkingLevel ?? "off",
	attached: true,
	locked: false,
	revision,
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
});

type Behavior = "acknowledge" | "hold" | "disconnect" | "protocol-error";

class SyntheticControlProtocol {
	readonly commands: Array<string> = [];
	readonly sessions = new Map<string, SessionSnapshot>();
	readonly locked = new Set<string>();
	readonly behavior = new Map<string, Behavior>();
	readonly models: ReadonlyArray<ModelMetadata>;
	#handlers: ByteTransportHandlers | undefined;
	#createCount = 0;

	constructor(models: ReadonlyArray<ModelMetadata>, ...sessions: ReadonlyArray<SessionSnapshot>) {
		this.models = models;
		for (const session of sessions) this.sessions.set(session.id, session);
	}

	readonly factory: ByteTransportFactory = (handlers) => {
		this.#handlers = handlers;
		const decoder = new ClientMessageDecoder();
		return {
			send: async (chunk) => {
				for (const message of decoder.push(chunk)) this.#receive(message);
			},
			close: handlers.onClose,
		};
	};

	emitSnapshot(next: SessionSnapshot): void {
		this.sessions.set(next.id, next);
		this.#deliver({type: "event", event: {type: "session_snapshot", snapshot: next}});
	}

	#receive(message: ClientMessage): void {
		if (message.type === "hello") {
			this.#deliver({
				type: "hello",
				version: PROTOCOL_VERSION,
				connectionId: "tuval-control-test",
				snapshot: {
					serverId: "synthetic",
					protocolVersion: PROTOCOL_VERSION,
					revision: 1,
					sessions: [...this.sessions.values()].map((session) => ({
						id: session.id,
						createdAt: session.createdAt,
						updatedAt: session.updatedAt,
						cwd: session.cwd,
					})),
					models: [...this.models],
				},
			});
			return;
		}
		const command = message.request;
		this.commands.push(command.command);
		const behavior = this.behavior.get(command.command) ?? "acknowledge";
		if (behavior === "hold") return;
		if (behavior === "disconnect") {
			this.#handlers?.onClose();
			return;
		}
		if (behavior === "protocol-error") {
			this.#deliver({
				type: "response",
				id: message.id,
				ok: false,
				error: {code: "invalid_request", message: `${command.command} was rejected`},
			});
			return;
		}
		if (command.command === "create") {
			const id = `created-${++this.#createCount}`;
			const next = snapshot(id);
			this.sessions.set(id, next);
			this.#deliver({
				type: "response",
				id: message.id,
				ok: true,
				result: {command: "create", session: next},
			});
			return;
		}
		if (command.command === "attach") {
			const current = this.sessions.get(command.sessionId);
			if (this.locked.has(command.sessionId)) {
				this.#deliver({
					type: "response",
					id: message.id,
					ok: false,
					error: {code: "session_locked", message: "another controller owns this session"},
				});
			} else if (current === undefined) {
				this.#deliver({
					type: "response",
					id: message.id,
					ok: false,
					error: {code: "not_found", message: "session not found"},
				});
			} else {
				this.#deliver({
					type: "response",
					id: message.id,
					ok: true,
					result: {command: "attach", session: current},
				});
			}
			return;
		}
		if (command.command === "detach") {
			this.#deliver({
				type: "response",
				id: message.id,
				ok: true,
				result: {command: "detach", sessionId: command.sessionId},
			});
			return;
		}
		if (command.command === "list" || command.command === "prompt") {
			throw new Error(`Unexpected synthetic command ${command.command}`);
		}
		const current = this.sessions.get(command.sessionId);
		if (current === undefined) throw new Error(`Missing synthetic session ${command.sessionId}`);
		if (command.command === "set_model") {
			const next = snapshot(current.id, current.revision + 1, {
				phase: current.phase,
				model: command.model,
				thinkingLevel: current.thinkingLevel,
			});
			this.sessions.set(current.id, next);
			this.#deliver({
				type: "response",
				id: message.id,
				ok: true,
				result: {command: "set_model", session: next},
			});
			return;
		}
		if (command.command === "set_thinking") {
			const next = snapshot(current.id, current.revision + 1, {
				phase: current.phase,
				model: current.model,
				thinkingLevel: command.thinkingLevel,
			});
			this.sessions.set(current.id, next);
			this.#deliver({
				type: "response",
				id: message.id,
				ok: true,
				result: {command: "set_thinking", session: next},
			});
			return;
		}
		if (command.command === "abort") {
			const next = snapshot(current.id, current.revision + 1, {
				phase: "idle",
				model: current.model,
				thinkingLevel: current.thinkingLevel,
			});
			this.sessions.set(current.id, next);
			this.#deliver({
				type: "response",
				id: message.id,
				ok: true,
				result: {command: "abort", session: next},
			});
			return;
		}
		const next = snapshot(current.id, current.revision + 1, {
			phase: current.phase,
			model: current.model,
			thinkingLevel: current.thinkingLevel,
		});
		this.sessions.set(current.id, next);
		this.#deliver({
			type: "response",
			id: message.id,
			ok: true,
			result: {command: "steer", session: next},
		});
	}

	#deliver(message: ServerMessage): void {
		this.#handlers?.onData(encodeServerMessage(message));
	}
}

class ManualDeadlines {
	readonly #pending: Array<{active: boolean; resolve: () => void}> = [];

	readonly make = (): AcknowledgementDeadline => {
		let resolve = () => {};
		const pending = {active: true, resolve};
		const elapsed = new Promise<void>((complete) => {
			resolve = complete;
			pending.resolve = complete;
		});
		this.#pending.push(pending);
		return {
			elapsed,
			cancel: () => {
				pending.active = false;
			},
		};
	};

	elapse(): void {
		const pending = this.#pending.find((candidate) => candidate.active);
		if (pending === undefined) throw new Error("No active acknowledgement deadline");
		pending.active = false;
		pending.resolve();
	}
}

const connect = (
	protocol: SyntheticControlProtocol,
	options: Parameters<typeof PiLiveSession.connect>[1] = {},
) =>
	Effect.acquireRelease(PiLiveSession.connect(protocol.factory, options), (service) =>
		service.dispose().pipe(Effect.ignore),
	);

describe("PiLiveSession acknowledged controls", () => {
	it.effect(
		"acknowledges create, open, model, thinking, steer, and abort from protocol truth",
		() =>
			Effect.gen(function* () {
				const small = model("small", ["off", "low"]);
				const large = model("large", ["off", "high"]);
				const existing = snapshot("existing");
				const protocol = new SyntheticControlProtocol([small, large], existing);
				const service = yield* connect(protocol);

				const created = yield* service.create({
					correlationId: "create-1",
					cwd: "/tmp/created",
					name: "Created",
				});
				assert.deepEqual(Schema.decodeUnknownSync(ControlLiveSessionOutcome)(created), created);
				assert.deepInclude(created, {
					_tag: "acknowledged",
					command: "create",
					correlationId: "create-1",
				});
				if (created._tag !== "acknowledged") return;
				assert.strictEqual(created.session.sessionId, "created-1");
				const retriedCreate = yield* service.create({
					correlationId: "create-1",
					cwd: "/tmp/created",
					name: "Created",
				});
				assert.deepEqual(retriedCreate, created);
				assert.lengthOf(
					protocol.commands.filter((command) => command === "create"),
					1,
				);

				const opened = yield* service.open({correlationId: "open-1", sessionId: existing.id});
				assert.deepInclude(opened, {
					_tag: "acknowledged",
					command: "open",
					correlationId: "open-1",
				});
				if (opened._tag !== "acknowledged") return;
				assert.strictEqual(opened.session.sessionId, existing.id);
				assert.isDefined(opened.session.controls);
				assert.deepInclude(opened.session.controls, {
					steer: false,
					abort: false,
					setModel: true,
					setThinking: true,
				});
				assert.deepEqual(
					opened.session.controls?.models.map((candidate) => candidate.model.id),
					["small", "large"],
				);

				const changedModel = yield* service.setModel({
					correlationId: "model-1",
					model: {provider: "synthetic", id: "large"},
				});
				assert.deepInclude(changedModel, {
					_tag: "acknowledged",
					command: "set-model",
					value: {provider: "synthetic", id: "large"},
				});
				const changedThinking = yield* service.setThinking({
					correlationId: "thinking-1",
					thinkingLevel: "high",
				});
				assert.deepInclude(changedThinking, {
					_tag: "acknowledged",
					command: "set-thinking",
					value: "high",
				});

				protocol.emitSnapshot(
					snapshot(existing.id, 4, {
						phase: "turn",
						model: {provider: "synthetic", id: "large"},
						thinkingLevel: "high",
					}),
				);
				assert.deepInclude((yield* service.current())?.controls, {
					steer: true,
					abort: true,
					setModel: false,
					setThinking: false,
				});
				const steered = yield* service.steer({correlationId: "steer-1", text: "redirect"});
				assert.deepInclude(steered, {_tag: "acknowledged", command: "steer"});
				const aborted = yield* service.abort({correlationId: "abort-1"});
				assert.deepInclude(aborted, {_tag: "acknowledged", command: "abort"});
				if (aborted._tag !== "acknowledged") return;
				assert.strictEqual(aborted.session.phase, "idle");
				assert.includeMembers(protocol.commands, [
					"create",
					"attach",
					"set_model",
					"set_thinking",
					"steer",
					"abort",
				]);
			}),
	);

	it.effect(
		"refuses invalid lease, phase, model, and thinking choices before optimistic writes",
		() =>
			Effect.gen(function* () {
				const existing = snapshot("existing");
				const locked = snapshot("locked");
				const protocol = new SyntheticControlProtocol(
					[model("small", ["off", "low"])],
					existing,
					locked,
				);
				protocol.locked.add(locked.id);
				const service = yield* connect(protocol);
				yield* service.open({correlationId: "open-existing", sessionId: existing.id});

				const commandCount = protocol.commands.length;
				assert.deepInclude(yield* service.steer({correlationId: "idle-steer", text: "no"}), {
					_tag: "refused",
					code: "unavailable",
				});
				assert.deepInclude(yield* service.abort({correlationId: "idle-abort"}), {
					_tag: "refused",
					code: "unavailable",
				});
				assert.deepInclude(
					yield* service.setModel({
						correlationId: "unknown-model",
						model: {provider: "synthetic", id: "missing"},
					}),
					{_tag: "refused", code: "unsupported-value"},
				);
				assert.deepInclude(
					yield* service.setThinking({correlationId: "unknown-thinking", thinkingLevel: "high"}),
					{_tag: "refused", code: "unsupported-value"},
				);
				assert.strictEqual(protocol.commands.length, commandCount);

				const refusedOpen = yield* service.open({
					correlationId: "open-locked",
					sessionId: locked.id,
				});
				assert.deepInclude(refusedOpen, {
					_tag: "refused",
					command: "open",
					code: "ownership-refused",
				});
				if (refusedOpen._tag !== "refused") return;
				assert.strictEqual(refusedOpen.session?.sessionId, existing.id);

				const noCapabilities = new SyntheticControlProtocol([], existing);
				const unsupportedService = yield* connect(noCapabilities);
				yield* unsupportedService.open({
					correlationId: "open-no-capabilities",
					sessionId: existing.id,
				});
				const beforeUnsupported = noCapabilities.commands.length;
				assert.deepInclude(
					yield* unsupportedService.setModel({
						correlationId: "model-not-supported",
						model: existing.model,
					}),
					{_tag: "refused", code: "unsupported-capability"},
				);
				assert.strictEqual(noCapabilities.commands.length, beforeUnsupported);
			}),
	);

	it.effect(
		"returns correlated timeout, disconnect, and protocol diagnostics with truthful state",
		() =>
			Effect.gen(function* () {
				const deadlines = new ManualDeadlines();
				const existing = snapshot("existing");
				const protocol = new SyntheticControlProtocol([model("small", ["off", "low"])], existing);
				const service = yield* connect(protocol, {makeAcknowledgementDeadline: deadlines.make});
				yield* service.open({correlationId: "open-existing", sessionId: existing.id});

				protocol.behavior.set("set_model", "hold");
				const pending = yield* service
					.setModel({
						correlationId: "model-timeout",
						model: {provider: "synthetic", id: "small"},
					})
					.pipe(Effect.forkChild);
				yield* Effect.yieldNow;
				deadlines.elapse();
				const timedOut = yield* Fiber.join(pending);
				assert.deepInclude(timedOut, {
					_tag: "refused",
					command: "set-model",
					correlationId: "model-timeout",
					code: "timeout",
				});
				if (timedOut._tag !== "refused") return;
				assert.deepEqual(timedOut.session?.model, existing.model);
			}),
	);

	it.effect(
		"classifies disconnect and protocol failures without changing the last projection",
		() =>
			Effect.gen(function* () {
				const existing = snapshot("existing");
				const disconnecting = new SyntheticControlProtocol(
					[model("small", ["off", "low"])],
					existing,
				);
				const disconnectedService = yield* connect(disconnecting);
				yield* disconnectedService.open({correlationId: "open-disconnect", sessionId: existing.id});
				disconnecting.behavior.set("set_thinking", "disconnect");
				const disconnected = yield* disconnectedService.setThinking({
					correlationId: "thinking-disconnect",
					thinkingLevel: "low",
				});
				assert.deepInclude(disconnected, {
					_tag: "refused",
					correlationId: "thinking-disconnect",
					code: "disconnected",
				});
				if (disconnected._tag !== "refused") return;
				assert.deepInclude(disconnected.session, {
					_tag: "disconnected",
					thinkingLevel: "off",
				});

				const protocol = new SyntheticControlProtocol([model("small", ["off", "low"])], existing);
				const service = yield* connect(protocol);
				yield* service.open({correlationId: "open-protocol", sessionId: existing.id});
				protocol.behavior.set("set_model", "protocol-error");
				const refused = yield* service.setModel({
					correlationId: "model-protocol",
					model: existing.model,
				});
				assert.deepInclude(refused, {
					_tag: "refused",
					correlationId: "model-protocol",
					code: "protocol",
					protocolCode: "invalid_request",
				});
				if (refused._tag !== "refused") return;
				assert.deepEqual(refused.session?.model, existing.model);
			}),
	);
});
