/**
 * The one place Pi's own types live. A `PiSessionHost` over a real `AgentSession` plus the JSONL
 * `SessionManager`; everything above it — dispatch, the ownership table, the connection — sees
 * protocol values only.
 *
 * The JSONL lands under the session's own cwd. Pi's default would put it in the user's agent dir
 * (`SessionManager.create(cwd)` slugs the cwd into `~/.pi/agent/sessions/<slug>/`), which is the
 * right home for the `pi` CLI and the wrong one for a Tuval process whose cwd is the project root
 * that booted the kernel: the process's transcripts belong beside the project's `.tuval/`, and a
 * test must not write into the operator's home to prove a session persisted.
 */

import {join} from "node:path";
import {
	type AgentSession,
	createAgentSession,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {ModelMetadata, ModelRef, ThinkingLevel} from "@earendil-works/pi-protocol";
import {Effect, Layer, Queue} from "effect";
import {projectModelCost, type SourceModelCost} from "./cost.ts";
import {SessionCallFailed, SessionOpenFailed} from "./errors.ts";
import {type PiSessionHandle, PiSessionHost, type PiSessionView} from "./PiSessionHost.ts";
import {projectTranscript, type SourceMessage} from "./transcript.ts";

export interface AgentSessionHostOptions {
	readonly modelRuntime: ModelRuntime;
	/** Pi's global config directory for this process. */
	readonly agentDir: string;
	/** Where a session's JSONL lands, from its cwd. Defaults to `<cwd>/.tuval/pi-sessions`. */
	readonly sessionDir?: (cwd: string) => string;
	/** Built-in tool suppression, passed straight through to `createAgentSession`. */
	readonly noTools?: "all" | "builtin" | undefined;
}

const allThinkingLevels: ReadonlyArray<ThinkingLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const detailOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Where a session's JSONL lands. Exported because it is a convention two modules share: this host
 * writes it and the Pi AI agent layer's `page` reads it back, and a second copy of the path would
 * be a second thing to keep in step.
 */
export const defaultSessionDir = (cwd: string): string => join(cwd, ".tuval", "pi-sessions");

/**
 * Pi's catalog is every model it knows of — 1312 at this pin — and a picker wants the ones this
 * process could actually run: a provider with credentials, or one registered into this runtime
 * directly (which is how a test's faux provider arrives).
 */
const offered = (runtime: ModelRuntime, provider: string): boolean =>
	runtime.hasConfiguredAuth(provider) ||
	runtime.getRegisteredNativeProvider(provider) !== undefined;

/**
 * The wire's `ModelCostSchema` floors every rate at 0, and openrouter's two auto-router entries
 * price themselves at -1000000 as a "varies" sentinel. A model the wire cannot describe is left
 * out rather than clamped, because clamping would quote a price that is not the model's.
 */
const describable = (model: {readonly cost: SourceModelCost}): boolean =>
	[model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every(
		(rate) => Number.isFinite(rate) && rate >= 0,
	);

const phaseOf = (session: AgentSession): PiSessionView["phase"] => {
	if (session.isCompacting) return "compaction";
	if (session.isRetrying) return "retry";
	if (session.isStreaming) return "turn";
	return "idle";
};

const call = <A>(
	session: AgentSession,
	name: string,
	run: () => Promise<A> | A,
): Effect.Effect<void, SessionCallFailed> =>
	Effect.tryPromise({
		try: async () => {
			await run();
		},
		catch: (error) =>
			new SessionCallFailed({
				sessionId: session.sessionId,
				call: name,
				detail: detailOf(error),
			}),
	});

export const layer = (options: AgentSessionHostOptions): Layer.Layer<PiSessionHost> =>
	Layer.succeed(PiSessionHost, {
		models: Effect.sync(() =>
			options.modelRuntime
				.getModels()
				.filter((model) => offered(options.modelRuntime, model.provider) && describable(model))
				.map(
					(model): ModelMetadata => ({
						provider: model.provider,
						id: model.id,
						name: model.name,
						api: model.api,
						reasoning: model.reasoning,
						input: model.input,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						cost: projectModelCost(model.cost),
						supportedThinkingLevels: model.reasoning ? [...allThinkingLevels] : ["off"],
						authenticated: options.modelRuntime.hasConfiguredAuth(model.provider),
					}),
				),
		),

		open: (request) =>
			Effect.gen(function* () {
				const changes = yield* Queue.make<void>({capacity: 1, strategy: "sliding"});
				const sessionDir = (options.sessionDir ?? defaultSessionDir)(request.cwd);
				const model =
					request.model === undefined
						? undefined
						: options.modelRuntime.getModel(request.model.provider, request.model.id);

				const session = yield* Effect.tryPromise({
					try: () =>
						createAgentSession({
							cwd: request.cwd,
							...(model === undefined ? {} : {model}),
							...(request.thinkingLevel === undefined
								? {}
								: {thinkingLevel: request.thinkingLevel}),
							modelRuntime: options.modelRuntime,
							sessionManager: SessionManager.create(request.cwd, sessionDir),
							settingsManager: SettingsManager.create(request.cwd, options.agentDir),
							...(options.noTools === undefined ? {} : {noTools: options.noTools}),
						}).then((result) => result.session),
					catch: (error) => new SessionOpenFailed({cwd: request.cwd, detail: detailOf(error)}),
				});

				if (request.name !== undefined) session.setSessionName(request.name);

				/**
				 * Every session event coalesces into one pending change. The server reads the
				 * session's state when it wakes, so a burst of deltas costs one snapshot rather
				 * than one per event — and a slow reader can never fall behind by more than a
				 * revision.
				 */
				const unsubscribe = session.subscribe(() => {
					Queue.offerUnsafe(changes, undefined);
				});

				const createdAt = Date.now();
				const handle: PiSessionHandle = {
					id: session.sessionId,
					cwd: request.cwd,
					file: session.sessionFile,
					createdAt,
					read: Effect.sync(
						(): PiSessionView => ({
							phase: phaseOf(session),
							model: {
								provider: session.model?.provider ?? "unknown",
								id: session.model?.id ?? "unknown",
							},
							thinkingLevel: session.thinkingLevel as ThinkingLevel,
							transcript: projectTranscript(session.messages as ReadonlyArray<SourceMessage>),
							name: session.sessionName,
							queuedSteer: session.getSteeringMessages(),
						}),
					),
					prompt: (text) =>
						call(session, "prompt", () => session.prompt(text, {expandPromptTemplates: false})),
					steer: (text) => call(session, "steer", () => session.steer(text)),
					abort: call(session, "abort", () => session.abort()),
					setModel: (ref: ModelRef) =>
						Effect.suspend(() => {
							const target = options.modelRuntime.getModel(ref.provider, ref.id);
							if (target === undefined) {
								return Effect.fail(
									new SessionCallFailed({
										sessionId: session.sessionId,
										call: "set_model",
										detail: `no model ${ref.provider}/${ref.id}`,
									}),
								);
							}
							return call(session, "set_model", () => session.setModel(target));
						}),
					setThinkingLevel: (level) =>
						call(session, "set_thinking", () => session.setThinkingLevel(level)),
					changes: Queue.take(changes),
					dispose: Effect.sync(() => {
						unsubscribe();
						session.dispose();
					}),
				};
				return handle;
			}),
	});
