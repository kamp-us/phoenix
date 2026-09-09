import {
	type Cause,
	Clock,
	Effect,
	Exit,
	Layer,
	Queue,
	Schema,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import type {AgentEvent} from "../ai-agent/events.ts";
import {
	isRefusal,
	KERNEL_TOOL_SERVER,
	kernelSpawnOf,
	planTranscriptPage,
} from "../ai-agent/history/index.ts";
import {
	ItemId,
	isThinkingLevel,
	Mode,
	type ModelRef,
	sameModel,
	type ThinkingLevel,
} from "../ai-agent/ports/index.ts";
import {
	ListError,
	ModelUnsupported,
	ModeUnsupported,
	PageError,
	PromptError,
	StartError,
	ThinkingUnsupported,
	TranscriptError,
	TransportError,
	TuvalAiAgent,
	type TuvalAiAgentApi,
	UnknownRequest,
} from "../ai-agent/service/index.ts";
import {KernelBridge} from "../ai-agent/tools/KernelBridge.ts";
import {ChildTranscriptError, readChildTranscript} from "./child-store.ts";
import {type CodexSessionConfigInput, codexModes, codexSessionSettings} from "./config.ts";
import {LiveTranscript} from "./history.ts";
import {PendingApprovals, permissionCard, permissionReply} from "./permissions.ts";
import * as Wire from "./protocol.ts";
import {resumeItems} from "./resume.ts";
import {readHistory, readModels, readSessions, readThread} from "./store.ts";
import {Activity, NativeSubagents} from "./subagents.ts";
import {serveKernelTools} from "./tools.ts";
import {
	type CodexCommand,
	type CodexConnect,
	type CodexConnection,
	nodeConnection,
	protocolError,
	type ServerMessage,
} from "./transport.ts";
import {TurnUsage} from "./usage.ts";

export interface CodexAiAgentOptions extends CodexCommand, CodexSessionConfigInput {
	readonly connect?: CodexConnect;
	readonly openTools?: typeof serveKernelTools;
}
type EventQueue = Queue.Queue<AgentEvent, TransportError | Cause.Done>;
type TurnState =
	| {readonly kind: "idle"}
	| {readonly kind: "sending"}
	| {readonly kind: "active"; readonly id: string};
interface Session {
	readonly id: string;
	readonly connection: CodexConnection;
	readonly scope: Scope.Closeable;
	readonly events: EventQueue;
	readonly pending: PendingApprovals;
	readonly transcript: LiveTranscript;
	readonly children: NativeSubagents;
	readonly childLock: Semaphore.Semaphore;
	connected: boolean;
	turn: TurnState;
	history: "unmaterialized" | "stored";
	readonly usage: TurnUsage;
}
const allowedApprovalMethods = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/permissions/requestApproval",
]);
const sandboxPolicy = (mode: Mode): Schema.Json =>
	mode === "read-only"
		? {type: "readOnly"}
		: {type: "workspaceWrite", writableRoots: [], networkAccess: false};
const offeredEfforts = (
	rows: ReadonlyArray<Wire.Model>,
	model: ModelRef | null,
): ReadonlyArray<ThinkingLevel> =>
	rows
		.find((row) => row.model === model?.id)
		?.supportedReasoningEfforts.map((row) => row.reasoningEffort)
		.filter(isThinkingLevel) ?? [];

const make = (options: CodexAiAgentOptions) =>
	Effect.gen(function* () {
		const bridge = yield* KernelBridge;
		const lifetime = yield* Effect.scope;
		const settings = codexSessionSettings(options);
		const connect = options.connect ?? nodeConnection(options);
		const lock = yield* Semaphore.make(1);
		let events = yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>();
		let session: Session | null = null;
		let mode = Mode.make(settings.mode);
		let model: ModelRef | null = null;
		let models: ReadonlyArray<Wire.Model> = [];
		let effort: ThinkingLevel | null = null;
		let keys = new Set<string>();
		const publish = (event: AgentEvent) => Effect.asVoid(Queue.offer(events, event));
		const emit = (current: Session, event: AgentEvent) =>
			Effect.asVoid(Queue.offer(current.events, event));
		const emitChild = (current: Session, event: AgentEvent | null) =>
			event === null ? Effect.void : emit(current, event);
		const finishChildren = Effect.fn("Codex.finishChildren")(function* (
			current: Session,
			line: string,
		) {
			for (const event of current.children.stopObserving(line)) yield* emit(current, event);
		});
		const refreshChildren = Effect.fn("Codex.refreshChildren")(function* (
			current: Session,
			all = false,
			only?: string,
		) {
			for (const [id, child] of current.children.children) {
				if (!current.children.observes(id) || (only !== undefined && id !== only)) continue;
				const slot = current.children.slots.get(child.call);
				if (slot === undefined || (!all && slot.status !== "running")) continue;
				const result = yield* Effect.result(
					readChildTranscript(current.connection, current.id, id),
				);
				if (!current.children.observes(id)) continue;
				if (result._tag === "Failure") {
					const text = `Child transcript ${result.failure.reason}: ${result.failure.detail}`;
					yield* emitChild(
						current,
						current.children.upsert(id, {
							kind: "system",
							id: ItemId.make("history-error"),
							timestamp: slot.startedAt,
							text,
						}),
					);
					const pending =
						result.failure.detail ===
						`thread ${id} is not materialized yet; includeTurns is unavailable before first user message`;
					if (!pending || slot.status !== "running")
						yield* emitChild(current, current.children.finishCall(child.call, text));
					continue;
				}
				yield* emitChild(current, current.children.hydrate(id, result.success));
			}
		});
		const clearApprovals = Effect.fn("Codex.clearApprovals")(function* (current: Session) {
			for (const resolved of current.pending.clear()) {
				yield* emit(current, {kind: "permission-resolved", ...resolved});
			}
		});
		const closeCurrent = Effect.gen(function* () {
			const current = session;
			session = null;
			if (current === null) return;
			yield* Scope.close(current.scope, Exit.void);
			yield* finishChildren(current, "Session closed");
			yield* clearApprovals(current);
		});
		yield* Effect.addFinalizer(() =>
			closeCurrent.pipe(Effect.andThen(Effect.suspend(() => Queue.shutdown(events)))),
		);

		const onChildMessage = Effect.fn("Codex.childMessage")(function* (
			current: Session,
			message: ServerMessage,
			childId: string,
		) {
			if (!current.children.observes(childId)) return;
			const {method, params} = message;
			switch (method) {
				case "item/started":
				case "item/completed": {
					const value = yield* Wire.decode(Wire.ItemEvent, params);
					const at = yield* Clock.currentTimeMillis;
					const event = yield* Effect.try({
						try: () => current.children.item(childId, value.item, at, method === "item/started"),
						catch: protocolError,
					});
					yield* emitChild(current, event);
					break;
				}
				case "item/agentMessage/delta":
				case "item/plan/delta":
				case "item/reasoning/summaryTextDelta":
				case "item/reasoning/textDelta": {
					const value = yield* Wire.decode(Wire.Delta, params);
					if (current.children.needsSnapshot(childId, value.itemId))
						yield* refreshChildren(current, false, childId);
					else
						yield* emitChild(current, current.children.delta(childId, value.itemId, value.delta));
					break;
				}
				case "thread/tokenUsage/updated": {
					const value = yield* Wire.decode(Wire.Usage, params);
					yield* emitChild(
						current,
						current.children.usage(
							childId,
							value.tokenUsage.total.inputTokens + value.tokenUsage.total.outputTokens,
						),
					);
					break;
				}
				case "turn/started": {
					const value = yield* Wire.decode(Wire.TurnEvent, params);
					const child = current.children.children.get(childId);
					if (child !== undefined) child.turnId = value.turn.id;
					yield* emitChild(current, current.children.status(childId, "running"));
					break;
				}
				case "turn/completed": {
					const value = yield* Wire.decode(Wire.TurnEvent, params);
					const child = current.children.children.get(childId);
					if (child !== undefined) {
						yield* refreshChildren(current, true, childId);
						child.turnId = null;
						yield* emitChild(
							current,
							current.children.finishCall(
								child.call,
								value.turn.error?.message ?? value.turn.status,
								value.turn.status !== "completed",
							),
						);
					}
					break;
				}
				case "error": {
					const value = yield* Wire.decode(
						Schema.Struct({
							error: Schema.Struct({message: Schema.String}),
							willRetry: Schema.Boolean,
						}),
						params,
					);
					const child = current.children.children.get(childId);
					if (!value.willRetry && child !== undefined)
						yield* emitChild(current, current.children.finishCall(child.call, value.error.message));
					break;
				}
			}
		});

		const onMessage = Effect.fn("Codex.message")(function* (
			current: Session,
			message: ServerMessage,
		) {
			const {method, params, id} = message;
			const envelope = Schema.decodeUnknownOption(Wire.ThreadEvent)(params);
			// Only the attached thread can ask this Tuval process for authority or publish its state.
			if (envelope._tag === "Some" && envelope.value.threadId !== current.id) {
				if (id !== undefined) {
					yield* current.connection.reject(id, "This thread is not attached to Tuval");
				} else if (current.children.children.has(envelope.value.threadId)) {
					yield* onChildMessage(current, message, envelope.value.threadId);
				}
				return;
			}
			if (id !== undefined) {
				if (allowedApprovalMethods.has(method)) {
					const value = yield* Wire.decode(Wire.Approval, params);
					const request = value.itemId;
					const detail = yield* Effect.try({
						try: () => permissionCard(method, params),
						catch: protocolError,
					});
					const visible = current.pending.add(request, {id, method, detail, decision: null});
					if (visible) yield* emit(current, {kind: "permission", request, detail});
				} else {
					yield* current.connection.reject(id, `Tuval cannot answer ${method}`);
					yield* emit(current, {
						kind: "failure",
						failure: {
							tag: "CodexRequestUnsupported",
							reason: null,
							detail: `Codex requested ${method}, which Tuval cannot answer.`,
						},
					});
				}
				return;
			}
			switch (method) {
				case "item/started":
				case "item/completed": {
					const value = yield* Wire.decode(Wire.ItemEvent, params);
					const now = yield* Clock.currentTimeMillis;
					const item = yield* Effect.try({
						try: () => current.transcript.item(value.item, now, method === "item/started"),
						catch: protocolError,
					});
					if (item.kind !== "assistant" || item.partial !== true || settings.streamPartialReplies)
						yield* emit(current, {kind: "item", item});
					// A kernel child's row opens off its spawning call settling, because the process id is
					// on that call's answer. It is the parent's own row and not a nested frame, so it
					// belongs here beside the collab arms rather than inside `NativeSubagents`, which
					// speaks for the children Codex spawns itself.
					if (method === "item/completed" && item.kind === "tool") {
						const spawn = kernelSpawnOf(item);
						if (spawn !== null)
							yield* emit(current, {
								kind: "subagent",
								slot: {
									id: item.id,
									type: spawn.program,
									lastLine: "",
									startedAt: item.timestamp,
									tokens: 0,
									items: [],
									status: "running",
									process: spawn.process,
								},
							});
					}
					const head = yield* Wire.decode(Wire.WireItem, value.item);
					if (head.type === "collabAgentToolCall") {
						const updates = yield* Effect.try({
							try: () => current.children.collab(value.item, current.id, now),
							catch: protocolError,
						});
						for (const update of updates) yield* emit(current, update);
						if (method === "item/completed") yield* refreshChildren(current, true);
					} else if (head.type === "subAgentActivity") {
						const activity = yield* Wire.decode(Activity, value.item);
						if (!current.children.children.has(activity.agentThreadId)) {
							yield* emit(current, {
								kind: "item",
								item: {
									...item,
									kind: "system",
									text: "Unsupported child activity: no spawning call is available",
								},
							});
						} else {
							yield* emitChild(
								current,
								current.children.status(
									activity.agentThreadId,
									activity.kind === "completed" || activity.kind === "interrupted"
										? "finished"
										: "running",
								),
							);
							yield* refreshChildren(current, true);
						}
					}
					break;
				}
				case "item/agentMessage/delta":
				case "item/plan/delta":
				case "item/reasoning/summaryTextDelta":
				case "item/reasoning/textDelta": {
					const value = yield* Wire.decode(Wire.Delta, params);
					const item = current.transcript.delta(value.itemId, value.delta);
					if (item !== null && (item.kind !== "assistant" || settings.streamPartialReplies))
						yield* emit(current, {kind: "item", item});
					break;
				}
				case "turn/started": {
					const value = yield* Wire.decode(Wire.TurnEvent, params);
					current.turn = {kind: "active", id: value.turn.id};
					current.history = "stored";
					yield* emit(current, {kind: "phase", phase: "prompting"});
					break;
				}
				case "turn/completed": {
					const value = yield* Wire.decode(Wire.TurnEvent, params);
					const usage = current.usage.finish(value.turn.id);
					if (usage !== undefined)
						yield* emit(current, {
							kind: "usage",
							turn: value.turn.id,
							model: model?.id ?? "",
							...usage,
							cost: 0,
						});
					for (const item of current.transcript.finish(value.turn.status === "interrupted"))
						yield* emit(current, {kind: "item", item});
					if (value.turn.error != null)
						yield* emit(current, {
							kind: "failure",
							failure: {
								tag: "CodexTurnFailed",
								reason: value.turn.status,
								detail: value.turn.error.message,
							},
						});
					yield* clearApprovals(current);
					if (value.turn.status !== "completed")
						yield* finishChildren(current, `Parent turn ${value.turn.status}`);
					else yield* refreshChildren(current);
					current.turn = {kind: "idle"};
					yield* emit(current, {kind: "phase", phase: "ready"});
					// The core settles slots at ready; an observed background worker is still running.
					for (const slot of current.children.slots.values())
						yield* emit(current, {kind: "subagent", slot});
					break;
				}
				case "serverRequest/resolved": {
					const value = yield* Wire.decode(Wire.Resolved, params);
					const resolved = current.pending.resolve(value.requestId);
					if (resolved !== null) {
						yield* emit(current, {
							kind: "permission-resolved",
							request: resolved.request,
							decision: resolved.decision,
						});
						if (resolved.next !== undefined)
							yield* emit(current, {
								kind: "permission",
								request: resolved.request,
								detail: resolved.next.detail,
							});
					}
					break;
				}
				case "thread/tokenUsage/updated": {
					const value = yield* Wire.decode(Wire.Usage, params);
					current.usage.record(value.turnId, value.tokenUsage.total, value.tokenUsage.last);
					break;
				}
				case "error": {
					const value = yield* Wire.decode(
						Schema.Struct({
							error: Schema.Struct({message: Schema.String}),
							willRetry: Schema.Boolean,
						}),
						params,
					);
					if (!value.willRetry) {
						yield* finishChildren(current, value.error.message);
						yield* emit(current, {
							kind: "failure",
							failure: {tag: "CodexError", reason: null, detail: value.error.message},
						});
					}
					break;
				}
			}
		});
		const publishControls = Effect.gen(function* () {
			yield* publish({kind: "mode", current: mode, available: codexModes});
			yield* publish({
				kind: "model",
				current: model,
				available: models.map((row) => ({id: row.model, name: row.displayName})),
			});
			yield* publish({kind: "thinking", current: effort, available: offeredEfforts(models, model)});
		});

		const start: TuvalAiAgentApi["start"] = (input) =>
			lock.withPermit(
				Effect.gen(function* () {
					const resumeId = input.resume?.sessionId;
					const continuing = session !== null && session.id === resumeId;
					yield* closeCurrent;
					yield* Queue.shutdown(events);
					events = yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>();
					yield* publish({kind: "phase", phase: "starting"});
					const scope = yield* Scope.make();
					const opening = Effect.gen(function* () {
						const selectedMode = input.mode ?? mode;
						if (!codexModes.includes(selectedMode))
							return yield* new StartError({
								reason: "refused",
								cwd: input.cwd,
								detail: `Unsupported mode: ${selectedMode}`,
							});
						const connection = yield* connect(input.cwd);
						if (input.resume !== undefined) {
							const stored = yield* readSessions(connection);
							if (!stored.some((row) => row.sessionId === resumeId))
								return yield* new StartError({
									reason: "session-not-found",
									cwd: input.cwd,
									detail: `No Codex session ${resumeId}`,
								});
						}
						const tools = yield* (options.openTools ?? serveKernelTools)().pipe(
							Effect.provideService(KernelBridge, bridge),
						);
						const params = {
							cwd: input.cwd,
							sandbox: selectedMode,
							approvalPolicy: "on-request",
							approvalsReviewer: "user",
							// The server name is what a settled spawn row is named by on this wire
							// (`<server>.<tool>`, `./history.ts`), so it is the mapper's constant and not a
							// second spelling of it (`../ai-agent/history/kernel-spawn.ts`).
							config: {
								[`mcp_servers.${KERNEL_TOOL_SERVER}`]: {...tools, enabled: true, required: true},
							},
							...(model === null
								? settings.model === undefined
									? {}
									: {model: settings.model}
								: {model: model.id}),
							...(input.resume === undefined
								? {historyMode: "legacy"}
								: {threadId: resumeId, excludeTurns: true}),
						};
						const opened = yield* connection
							.request(input.resume === undefined ? "thread/start" : "thread/resume", params)
							.pipe(Effect.flatMap((value) => Wire.decode(Wire.Opened, value)));
						if (input.resume !== undefined && opened.thread.id !== resumeId)
							return yield* protocolError("Codex resumed a different session");
						if (opened.thread.canAcceptDirectInput === false)
							return yield* new StartError({
								reason: "refused",
								cwd: input.cwd,
								detail: "This Codex session is owned by its parent agent",
							});
						const actualMode =
							opened.sandbox.type === "readOnly"
								? "read-only"
								: opened.sandbox.type === "workspaceWrite"
									? "workspace-write"
									: null;
						if (actualMode !== selectedMode || opened.approvalPolicy !== "on-request")
							return yield* protocolError("Codex did not apply the requested permission settings");
						mode = selectedMode;
						models = yield* readModels(connection);
						model = {
							id: opened.model,
							name: models.find((row) => row.model === opened.model)?.displayName ?? opened.model,
						};
						effort = isThinkingLevel(opened.reasoningEffort) ? opened.reasoningEffort : null;
						if (!continuing) keys = new Set();
						const current: Session = {
							id: opened.thread.id,
							connection,
							scope,
							events,
							pending: new PendingApprovals(),
							transcript: new LiveTranscript(),
							children: new NativeSubagents(),
							childLock: yield* Semaphore.make(1),
							connected: true,
							turn: {kind: "idle"},
							history: input.resume === undefined ? "unmaterialized" : "stored",
							usage: new TurnUsage(),
						};
						if (input.resume !== undefined) {
							const stored = yield* readThread(connection, current.id);
							for (const turn of stored.turns)
								for (const raw of turn.items) {
									const head = yield* Wire.decode(Wire.WireItem, raw);
									if (head.type === "collabAgentToolCall") {
										const updates = yield* Effect.try({
											try: () =>
												current.children.collab(
													raw,
													current.id,
													(turn.startedAt ?? stored.createdAt) * 1000,
												),
											catch: protocolError,
										});
										for (const update of updates) yield* emit(current, update);
									}
								}
							yield* refreshChildren(current, true);
							const history = yield* readHistory(connection, current.id);
							for (const item of resumeItems(history, input.resume))
								yield* emit(current, {kind: "item", item});
							for (const item of history)
								yield* emit(current, {
									kind: "permission-resolved",
									request: item.id,
									decision: "deny",
								});
						}
						session = current;
						yield* publishControls;
						yield* publish({kind: "commands", available: []});
						yield* publish({kind: "phase", phase: "ready"});
						for (const slot of current.children.slots.values())
							yield* emit(current, {kind: "subagent", slot});
						yield* Effect.gen(function* () {
							while (current.connected) {
								yield* Effect.sleep("1 second");
								yield* current.childLock.withPermit(refreshChildren(current));
							}
						}).pipe(Effect.forkIn(scope));
						yield* current.connection.messages.pipe(
							Stream.runForEach((message) =>
								current.childLock.withPermit(onMessage(current, message)),
							),
							Effect.andThen(
								Effect.fail(
									new TransportError({reason: "disconnected", detail: "Codex event stream ended"}),
								),
							),
							Effect.catch((error) =>
								Effect.gen(function* () {
									current.connected = false;
									yield* finishChildren(current, error.detail);
									yield* clearApprovals(current);
									yield* Queue.fail(current.events, error);
									yield* Scope.close(current.scope, Exit.void).pipe(Effect.forkIn(lifetime));
								}),
							),
							Effect.forkIn(scope),
						);
						return {sessionId: current.id};
					});
					return yield* Scope.provide(scope)(opening).pipe(
						Effect.mapError((error) =>
							error instanceof StartError
								? error
								: new StartError({
										reason: error.reason === "refused" ? "refused" : "transport",
										cwd: input.cwd,
										detail: error.detail,
									}),
						),
						Effect.onExit((exit) =>
							Exit.isSuccess(exit)
								? Effect.void
								: Scope.close(scope, Exit.void).pipe(
										Effect.andThen(publish({kind: "phase", phase: "gone"})),
									),
						),
					);
				}),
			);

		const prompt: TuvalAiAgentApi["prompt"] = (text, key) =>
			lock.withPermit(
				Effect.gen(function* () {
					const current = session;
					if (current === null)
						return yield* new PromptError({
							reason: "no-session",
							detail: "Start a Codex session first",
						});
					if (!current.connected)
						return yield* new PromptError({
							reason: "disconnected",
							detail: "Reconnect the Codex session first",
						});
					if (key !== undefined && keys.has(key)) return;
					if (current.turn.kind !== "idle")
						return yield* new PromptError({
							reason: "refused",
							detail: "Codex is already running a turn",
						});
					if (key !== undefined) keys.add(key);
					current.turn = {kind: "sending"};
					yield* emit(current, {kind: "phase", phase: "prompting"});
					yield* current.connection
						.request("turn/start", {
							threadId: current.id,
							input: [{type: "text", text, text_elements: []}],
							...(key === undefined ? {} : {clientUserMessageId: key}),
						})
						.pipe(
							Effect.flatMap((value) => Wire.decode(Wire.TurnReply, value)),
							Effect.tap((reply) =>
								Effect.sync(() => {
									if (current.turn.kind === "sending")
										current.turn = {kind: "active", id: reply.turn.id};
									current.history = "stored";
								}),
							),
							Effect.tapError((error) =>
								Effect.sync(() => {
									if (error.reason === "refused") {
										if (key !== undefined) keys.delete(key);
										current.turn = {kind: "idle"};
									}
								}),
							),
							Effect.mapError(
								(error) =>
									new PromptError({
										reason: error.reason === "refused" ? "refused" : "disconnected",
										detail: error.detail,
									}),
							),
						);
				}),
			);
		const interrupt = Effect.gen(function* () {
			const current = session;
			if (current === null) return;
			for (const [id, child] of current.children.children) {
				if (child.turnId !== null && current.children.slots.get(child.call)?.status === "running")
					yield* current.connection
						.request("turn/interrupt", {threadId: id, turnId: child.turnId})
						.pipe(
							Effect.catch((error) =>
								emitChild(current, current.children.interruptRefused(id, error.detail)),
							),
						);
			}
			if (current.turn.kind !== "active") return;
			yield* current.connection
				.request("turn/interrupt", {threadId: current.id, turnId: current.turn.id})
				.pipe(
					Effect.catch((error) =>
						emit(current, {
							kind: "failure",
							failure: {
								tag: "tuval/ai-agent/InterruptError",
								reason: current.turn.kind === "idle" ? "no-live-turn" : "turn-running",
								detail: `Codex refused to interrupt the turn: ${error.detail}`,
							},
						}),
					),
				);
		});
		const answer: TuvalAiAgentApi["answer"] = (request, decision) =>
			Effect.gen(function* () {
				const current = session;
				const pending = current?.pending.get(request);
				if (current == null || pending === undefined || pending.decision !== null)
					return yield* new UnknownRequest({request});
				pending.decision = decision === "allow-always" ? "deny" : decision;
				yield* Effect.try({
					try: () => permissionReply(pending, pending.decision ?? "deny"),
					catch: protocolError,
				}).pipe(
					Effect.flatMap((result) => current.connection.reply(pending.id, result)),
					Effect.catch((error) => Queue.fail(current.events, error)),
				);
			});
		const applySettings = (patch: Readonly<Record<string, Schema.Json>>) =>
			Effect.gen(function* () {
				const current = session;
				if (current === null) return true;
				if (!current.connected) return false;
				return yield* current.connection
					.request("thread/settings/update", {threadId: current.id, ...patch})
					.pipe(
						Effect.as(true),
						Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as(false))),
					);
			});
		const setMode: TuvalAiAgentApi["setMode"] = (next) =>
			lock.withPermit(
				Effect.gen(function* () {
					if (!codexModes.includes(next))
						return yield* new ModeUnsupported({mode: next, available: codexModes});
					if (
						yield* applySettings({
							sandboxPolicy: sandboxPolicy(next),
							approvalPolicy: "on-request",
							approvalsReviewer: "user",
						})
					)
						mode = next;
					yield* publishControls;
				}),
			);
		const setModel: TuvalAiAgentApi["setModel"] = (next) =>
			lock.withPermit(
				Effect.gen(function* () {
					const picked = models.find((row) =>
						sameModel({id: row.model, name: row.displayName}, next),
					);
					if (picked === undefined)
						return yield* new ModelUnsupported({
							model: next.id,
							available: models.map((row) => row.model),
						});
					const levels = offeredEfforts(models, next);
					const nextEffort =
						effort !== null && levels.includes(effort)
							? effort
							: isThinkingLevel(picked.defaultReasoningEffort)
								? picked.defaultReasoningEffort
								: null;
					if (yield* applySettings({model: picked.model, effort: nextEffort})) {
						model = {id: picked.model, name: picked.displayName};
						effort = nextEffort;
					}
					yield* publishControls;
				}),
			);
		const setThinkingLevel: TuvalAiAgentApi["setThinkingLevel"] = (next) =>
			lock.withPermit(
				Effect.gen(function* () {
					const levels = offeredEfforts(models, model);
					if (!levels.includes(next))
						return yield* new ThinkingUnsupported({level: next, available: levels});
					if (yield* applySettings({effort: next})) effort = next;
					yield* publishControls;
				}),
			);
		const page: TuvalAiAgentApi["page"] = (before, limit) =>
			Effect.gen(function* () {
				const current = session;
				if (current === null)
					return yield* new PageError({
						reason: "disconnected",
						detail: "Start a Codex session first",
					});
				if (current.history === "unmaterialized") {
					if (before !== null)
						return yield* new PageError({
							reason: "unknown-cursor",
							detail: "This session has no history yet",
						});
					return {items: [], hasMore: false};
				}
				const items = yield* readHistory(current.connection, current.id).pipe(
					Effect.mapError(
						(error) => new PageError({reason: "store-unreadable", detail: error.detail}),
					),
				);
				const planned = planTranscriptPage(items, {before, limit});
				if (isRefusal(planned))
					return yield* new PageError({reason: "unknown-cursor", detail: planned.reason});
				return {items: planned.items, hasMore: planned.next !== null};
			});
		const sessionTranscript: TuvalAiAgentApi["sessionTranscript"] = (query) =>
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* connect(query.cwd);
					const sessions = yield* readSessions(connection);
					if (!sessions.some((row) => row.sessionId === query.sessionId))
						return yield* new TranscriptError({
							reason: "session-not-found",
							sessionId: query.sessionId,
							detail: "No Codex session with this id",
						});
					const items = yield* readHistory(connection, query.sessionId);
					const planned = planTranscriptPage(items, {before: query.before, limit: query.limit});
					if (isRefusal(planned))
						return yield* new TranscriptError({
							reason: "unknown-cursor",
							sessionId: query.sessionId,
							detail: planned.reason,
						});
					return {items: planned.items, hasMore: planned.next !== null};
				}),
			).pipe(
				Effect.mapError((error) =>
					error instanceof TranscriptError
						? error
						: new TranscriptError({
								reason: "store-unreadable",
								sessionId: query.sessionId,
								detail: error.detail,
							}),
				),
			);
		const listSessions = Effect.scoped(
			Effect.gen(function* () {
				const connection = yield* connect(".");
				return yield* readSessions(connection);
			}),
		).pipe(
			Effect.mapError((error) => new ListError({reason: "store-unreadable", detail: error.detail})),
		);
		const subagentTranscript = Effect.fn("Codex.subagentTranscript")(function* (id: string) {
			const current = session;
			if (current === null || !current.children.children.has(id))
				return yield* new ChildTranscriptError({
					reason: "missing",
					detail: "No correlated child in this session",
				});
			return yield* readChildTranscript(current.connection, current.id, id);
		});
		return {
			start,
			subagentTranscript,
			prompt,
			interrupt,
			answer,
			setMode,
			setModel,
			setThinkingLevel,
			commands: Effect.succeed([]),
			page,
			sessionTranscript,
			listSessions,
			events: Stream.unwrap(Effect.sync(() => Stream.fromQueue(events))),
		};
	});

export const CodexAiAgent = {
	layer: (options: CodexAiAgentOptions = {}): Layer.Layer<TuvalAiAgent, never, KernelBridge> =>
		Layer.effect(TuvalAiAgent, make(options)),
};
