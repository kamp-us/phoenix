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

import {readdirSync} from "node:fs";
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
	/**
	 * The cwd a session resumed by id is looked up under — the project root that booted the kernel
	 * (founder ruling, 2026-09-02). One process runs one project, so one root locates every JSONL
	 * this host could be asked to re-open. Absent means this host resumes nothing, and every
	 * `resume` refuses.
	 */
	readonly projectRoot?: string;
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

/**
 * One session's JSONL, by id, in the directory this host writes them to.
 *
 * `SessionManager.create` names a file `<timestamp>_<sessionId>.jsonl` (`dist/core/session-manager.js`),
 * so the id locates the file and no second index has to be kept in step. Raw `node:fs` under
 * `.patterns/effect-platform-access.md`'s "a `node:*`-only API the platform service doesn't expose"
 * case, for the reason the Pi agent layer's own `readBranch` reads that way: `SessionManager.open`
 * does its own synchronous reads with no seam to substitute.
 */
const sessionFile = (dir: string, sessionId: string): string | undefined => {
	const name = readdirSync(dir).find((entry) => entry.endsWith(`_${sessionId}.jsonl`));
	return name === undefined ? undefined : join(dir, name);
};

/**
 * The handle over a live `AgentSession`. Everything the ownership table and the dispatch see of Pi
 * is this record, whether the session was created fresh or re-opened off its store.
 */
const handleOf = (
	options: AgentSessionHostOptions,
	session: AgentSession,
	cwd: string,
): Effect.Effect<PiSessionHandle> =>
	Effect.gen(function* () {
		const changes = yield* Queue.make<void>({capacity: 1, strategy: "sliding"});
		/**
		 * Every session event coalesces into one pending change. The server reads the session's
		 * state when it wakes, so a burst of deltas costs one snapshot rather than one per event —
		 * and a slow reader can never fall behind by more than a revision.
		 */
		const unsubscribe = session.subscribe(() => {
			Queue.offerUnsafe(changes, undefined);
		});
		const createdAt = Date.now();
		return {
			id: session.sessionId,
			cwd,
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
		} satisfies PiSessionHandle;
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
				return yield* handleOf(options, session, request.cwd);
			}),

		/**
		 * `SessionManager.open` on the saved file, handed to `createAgentSession` — Pi's own
		 * documented way to continue a previous session (`dist/core/sdk.d.ts`'s `sessionManager`
		 * option and its "Continue previous session" example). The session comes back under its own
		 * id, because `AgentSession.sessionId` reads the manager's (`dist/core/agent-session.js`),
		 * so a resume can never mint a new one and pass it off as the old.
		 */
		resume: (sessionId) =>
			Effect.gen(function* () {
				const cwd = options.projectRoot;
				if (cwd === undefined) {
					return yield* new SessionOpenFailed({
						cwd: "",
						detail: `this host holds no project root, so session ${sessionId} cannot be re-opened`,
					});
				}
				const dir = (options.sessionDir ?? defaultSessionDir)(cwd);
				const refuse = (detail: string) => new SessionOpenFailed({cwd, detail});
				const file = yield* Effect.try({
					try: () => sessionFile(dir, sessionId),
					catch: (error) => refuse(detailOf(error)),
				});
				if (file === undefined) return yield* refuse(`no session file for ${sessionId} in ${dir}`);

				const session = yield* Effect.tryPromise({
					try: () =>
						createAgentSession({
							cwd,
							modelRuntime: options.modelRuntime,
							sessionManager: SessionManager.open(file, dir, cwd),
							settingsManager: SettingsManager.create(cwd, options.agentDir),
							...(options.noTools === undefined ? {} : {noTools: options.noTools}),
						}).then((result) => result.session),
					catch: (error) => refuse(detailOf(error)),
				});
				return yield* handleOf(options, session, cwd);
			}),
	});
