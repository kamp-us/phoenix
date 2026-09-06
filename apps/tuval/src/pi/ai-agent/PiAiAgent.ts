/**
 * `PiAiAgent` — the `TuvalAiAgent` layer over the loopback Pi server (#7567) and the Node-side
 * lease client (#7568). Pi's protocol stops at this file: everything it hands a caller is a port
 * value, and everything it takes is one.
 *
 * The layer is the transport's lifetime (founder ruling 4, #7570). Building it stands up Pi's
 * model runtime and the session host over it, one loopback server on 127.0.0.1 port 0 with its own
 * per-launch capability token, and a client dialled at that server — all acquired against the scope
 * it was built in; closing that scope closes the client, the server and every session exactly once.
 * `start` is therefore the handler's call, not the layer's — restore is "rebuild the layer, then
 * `start({cwd, resume: sessionId})`".
 *
 * Reconnect is explicit and has one route. A dropped socket fails `events` once with a
 * `TransportError` and nothing dials again; the generic handlers decide to reconnect, and the way
 * back in is another `start({cwd, resume})`, which re-dials and reacquires the session by id. That
 * is why `events` resolves the live queue at subscription time rather than closing over one: a
 * subscription taken after the re-`start` is live, and one taken before is not resurrected. That
 * exit is the dropped socket's alone: a turn the session refuses rides `events` as a `failure`
 * event, because the session is still there and every later turn still has to reach the window
 * (#8018).
 *
 * Pi offers no permission prompts and no modes at this pin, so `permission` emits nothing, `mode`
 * advertises an empty list, and `answer` and `setMode` refuse as data rather than throwing. Models
 * it does offer: the `hello` frame's catalog is the list, `set_model` is the switch, and it applies
 * to the running session rather than to the next one. A pick made before any session exists is held
 * and opens the next one, so "not offered" and "no session yet" stay two different answers (#7981).
 *
 * Thinking levels ride the same shape (#8062), with one difference the model axis does not have:
 * the offered set is *per model*, since each catalog row carries its own
 * `supportedThinkingLevels` — the whole vocabulary for a reasoning model, `off` alone otherwise
 * (`../server/AgentSessionHost.ts`). So a model switch re-announces the thinking set too, and a
 * level the new model does not offer stops being pickable with it.
 */

import {readdirSync} from "node:fs";
import {join} from "node:path";
import {getAgentDir, ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {type Cause, Effect, Fiber, Layer, Queue, Redacted, Ref, type Scope, Stream} from "effect";
import {isRefusal, planTranscriptPage} from "../../ai-agent/history/index.ts";
import type {
	Mode,
	ModelRef,
	PermissionDecision,
	ThinkingLevel,
} from "../../ai-agent/ports/index.ts";
import {sameModel} from "../../ai-agent/ports/index.ts";
import {
	type AgentEvent,
	ModelUnsupported,
	ModeUnsupported,
	PageError,
	PromptError,
	ThinkingUnsupported,
	type TransportError,
	TuvalAiAgent,
	type TuvalAiAgentApi,
	UnknownRequest,
} from "../../ai-agent/service/index.ts";
import {PiClientService, type PiSessionRef} from "../client/index.ts";
import {
	agentSessionHostLayer,
	defaultSessionDir,
	ModelRuntimeUnavailable,
	type PiServerLimits,
	PiServerService,
	type PiSessionHost,
	type ServerBindFailed,
} from "../server/index.ts";
import {pageItems} from "./entries.ts";
import {emptyProjection, eventsOf} from "./items.ts";
import {
	promptDropOf,
	promptErrorOf,
	promptFailureOf,
	startErrorOf,
	storeUnreadable,
	transportErrorOf,
} from "./refusals.ts";

/** A model this process may run, named the way Pi's catalog names one. */
export interface ModelSelection {
	readonly provider: string;
	readonly id: string;
}

export interface PiAiAgentOptions {
	/** The loopback interface the server binds. Defaults to `127.0.0.1`. */
	readonly host?: string;
	readonly limits?: Partial<PiServerLimits>;
	/** The model a new session opens on. Absent leaves Pi's own default. */
	readonly model?: ModelSelection;
	/** Where this session's JSONL lives, from its cwd. Defaults to the host's own convention. */
	readonly sessionDir?: (cwd: string) => string;
	/**
	 * The project root that booted the kernel: where a `start({cwd, resume})` after a restart looks
	 * for the saved session's JSONL, since the server it is dialling has never held that session.
	 * Absent means this layer resumes nothing across a restart and a saved id answers
	 * `session-not-found`.
	 */
	readonly projectRoot?: string;
	/**
	 * Pi's config directory for this process — its credentials and its model catalog. Defaults to
	 * Pi's own (`$PI_AGENT_DIR`, else `~/.pi/agent`).
	 */
	readonly agentDir?: string;
}

type EventQueue = Queue.Queue<AgentEvent, TransportError | Cause.Done>;

/**
 * Read one session's branch out of Pi's JSONL, oldest-first.
 *
 * `SessionManager.create` names a file `<timestamp>_<sessionId>.jsonl` in the session directory
 * (`dist/core/session-manager.js`), so the id locates the file without a second index to keep.
 * The directory scan is raw `node:fs` rather than the `FileSystem` service, under
 * `.patterns/effect-platform-access.md`'s "a `node:*`-only API the platform service doesn't
 * expose" case: `SessionManager.open` does its own synchronous reads with no seam to substitute,
 * so routing only the `readdir` would move half of one read behind a service and leave the rest
 * where it was. The whole call sits in one `Effect.try` with a typed error, which is that case's
 * stated shape.
 */
const readBranch = (dir: string, sessionId: string, cwd: string) =>
	Effect.try({
		try: () => {
			const file = readdirSync(dir).find((name) => name.endsWith(`_${sessionId}.jsonl`));
			if (file === undefined) {
				throw new Error(`no session file for ${sessionId} in this session's history directory`);
			}
			return SessionManager.open(join(dir, file), dir, cwd).getBranch();
		},
		catch: storeUnreadable,
	});

/**
 * One catalog row as the interface names a model. The server's `hello` frame already carries the
 * `offered()` set — authenticated and describable — so nothing here filters again, and the raw
 * runtime catalog (four figures at this pin) never reaches the core.
 */
const refOf = (model: {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
}): ModelRef => ({provider: model.provider, id: model.id, name: model.name});

/**
 * What one model may be asked to think at, off the same catalog row. A model the catalog does not
 * describe offers nothing rather than the whole vocabulary — a picker over levels the session would
 * refuse is the inert control this replaces.
 */
const levelsOf = (
	catalog: ReadonlyArray<{
		readonly provider: string;
		readonly id: string;
		readonly name: string;
		readonly supportedThinkingLevels: ReadonlyArray<ThinkingLevel>;
	}>,
	model: {readonly provider: string; readonly id: string},
): ReadonlyArray<ThinkingLevel> =>
	catalog.find((row) => row.provider === model.provider && row.id === model.id)
		?.supportedThinkingLevels ?? [];

const without =
	(key: string) =>
	(seen: ReadonlySet<string>): ReadonlySet<string> => {
		const next = new Set(seen);
		next.delete(key);
		return next;
	};

const make = (
	options: PiAiAgentOptions,
): Effect.Effect<TuvalAiAgentApi, never, Scope.Scope | PiClientService> =>
	Effect.gen(function* () {
		const pi = yield* PiClientService;
		const scope = yield* Effect.scope;
		const sessionDir = options.sessionDir ?? defaultSessionDir;

		const session = yield* Ref.make<PiSessionRef | null>(null);
		// The pick an operator made before a session existed. It survives to the next `start`,
		// which opens on it — the shape `ClaudeAiAgent` holds one across a respawn.
		const pendingModel = yield* Ref.make<ModelSelection | null>(null);
		const pendingThinking = yield* Ref.make<ThinkingLevel | null>(null);
		const keys = yield* Ref.make<ReadonlySet<string>>(new Set());
		const dialled = yield* Ref.make(false);
		const pump = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

		const queue = yield* Effect.acquireRelease(
			Ref.make<EventQueue>(yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>()),
			(held) => Effect.flatMap(Ref.get(held), Queue.shutdown),
		);

		const emit = (open: EventQueue, events: ReadonlyArray<AgentEvent>): Effect.Effect<void> =>
			// Serial: one subscription, one ordering — a parallel offer would shuffle a revision.
			Effect.forEach(events, (event) => Queue.offer(open, event), {concurrency: 1, discard: true});

		/**
		 * The snapshot fan for one session, racing the first disconnection. A drop wins the race,
		 * fails the queue exactly once and interrupts the fan, which is the whole of "one
		 * `Disconnected` and no reconnect until `start` is called again".
		 */
		const follow = (sessionId: string, open: EventQueue): Effect.Effect<void> =>
			Effect.gen(function* () {
				const projection = yield* Ref.make(emptyProjection);
				const snapshots = pi.snapshots(sessionId).pipe(
					Stream.runForEach((snapshot) =>
						Effect.gen(function* () {
							const previous = yield* Ref.get(projection);
							const folded = eventsOf(previous, snapshot);
							yield* Ref.set(projection, folded.next);
							yield* emit(open, folded.events);
						}),
					),
				);
				const dropped = pi.disconnections.pipe(
					Stream.take(1),
					Stream.runForEach((drop) => Queue.fail(open, transportErrorOf(drop))),
				);
				yield* Effect.race(snapshots, dropped);
			});

		/**
		 * The session's model as the offered list names it. The wire ref carries no display name, so
		 * the catalog row is what a menu renders; a session on a model the catalog does not offer is
		 * still reported, labelled by its id, rather than read as no model at all.
		 */
		const currentOf = (
			offered: ReadonlyArray<ModelRef>,
			wire: {readonly provider: string; readonly id: string},
		): ModelRef =>
			offered.find((candidate) => sameModel(candidate, {...wire, name: wire.id})) ?? {
				...wire,
				name: wire.id,
			};

		const announce = (current: ModelRef, offered: ReadonlyArray<ModelRef>): Effect.Effect<void> =>
			Effect.flatMap(Ref.get(queue), (open) =>
				emit(open, [{kind: "model", current, available: offered}]),
			);

		const announceThinking = (
			current: ThinkingLevel | null,
			offered: ReadonlyArray<ThinkingLevel>,
		): Effect.Effect<void> =>
			Effect.flatMap(Ref.get(queue), (open) =>
				emit(open, [{kind: "thinking", current, available: offered}]),
			);

		/** The refused-switch shape `applySwitch` has, over the thinking axis. */
		const applyThinking = (
			sessionId: string,
			level: ThinkingLevel,
			fallback: ThinkingLevel,
		): Effect.Effect<ThinkingLevel> =>
			pi.setThinkingLevel(sessionId, level).pipe(
				Effect.map((answered) => answered.thinkingLevel),
				Effect.catch((refusal) =>
					Effect.as(
						Effect.logWarning(`the thinking switch was refused: ${refusal.message}`),
						fallback,
					),
				),
			);

		/**
		 * The live switch. The `setModel` error channel declares only `ModelUnsupported`, and a
		 * refused switch is not that: the model did not change, so the caller's fallback is
		 * re-announced rather than a lie being put on the stream.
		 */
		const applySwitch = (
			sessionId: string,
			selection: ModelSelection,
			fallback: PiSessionRef["model"],
		): Effect.Effect<PiSessionRef["model"]> =>
			pi.setModel(sessionId, selection).pipe(
				Effect.map((answered) => answered.model),
				Effect.catch((refusal) =>
					Effect.as(
						Effect.logWarning(`the model switch was refused: ${refusal.message}`),
						fallback,
					),
				),
			);

		/** Dials on the first `start`, and re-dials on a later one — the pin's `reconnect()` refuses a live client. */
		const dial = Effect.gen(function* () {
			if (yield* pi.connected) return;
			const first = !(yield* Ref.get(dialled));
			yield* first ? pi.connect : pi.reconnect;
			yield* Ref.set(dialled, true);
		});

		const start = Effect.fn("TuvalAiAgent.start")(function* (options_: {
			readonly cwd: string;
			readonly resume?: string;
		}) {
			const previous = yield* Ref.get(pump);
			if (previous !== null) yield* Fiber.interrupt(previous);
			yield* Effect.flatMap(Ref.get(queue), Queue.shutdown);

			const open = yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>();
			yield* Ref.set(queue, open);
			yield* emit(open, [{kind: "phase", phase: "starting"}]);

			const acquire = Effect.gen(function* () {
				yield* dial;
				// A held pick outranks the layer's static option: it is the later choice, and this
				// open is the one it was made for.
				const opening = (yield* Ref.get(pendingModel)) ?? options.model;
				return options_.resume === undefined
					? yield* pi.createSession(options_.cwd, opening === undefined ? {} : {model: opening})
					: yield* pi.attachSession(options_.resume);
			}).pipe(Effect.mapError((refusal) => startErrorOf(options_.cwd, refusal)));

			// One stream carries everything (ruling 1, #7570), so a failed start owes it a terminal
			// phase: without this every subscriber sits on `starting` for the life of the layer.
			const ref = yield* acquire.pipe(
				Effect.tapError(() => emit(open, [{kind: "phase", phase: "gone"}])),
			);

			// A `start({resume})` reattaches to a session already on its own stored model, and a
			// create can answer on another, so a held pick is applied here rather than assumed to
			// have landed. Spending it either way is what stops it re-applying on every later start.
			const pick = yield* Ref.get(pendingModel);
			const running =
				pick === null || (ref.model.provider === pick.provider && ref.model.id === pick.id)
					? ref.model
					: yield* applySwitch(ref.id, pick, ref.model);
			yield* Ref.set(pendingModel, null);

			// The same shape one line up, over the thinking axis: a level held from before this
			// session existed is applied here rather than assumed to have landed, and spent either
			// way. A level the model this open landed on does not offer is dropped, not sent.
			const wanted = yield* Ref.get(pendingThinking);
			const catalog = yield* pi.models;
			const levels = levelsOf(catalog, running);
			const thinking =
				wanted === null || wanted === ref.thinkingLevel || !levels.includes(wanted)
					? ref.thinkingLevel
					: yield* applyThinking(ref.id, wanted, ref.thinkingLevel);
			yield* Ref.set(pendingThinking, null);

			yield* Ref.set(session, {...ref, model: running, thinkingLevel: thinking});
			// Forked into the layer's own scope, not the caller's, so the fan lives exactly as long
			// as the transport it reads and dies with it.
			yield* Ref.set(pump, yield* Effect.forkIn(follow(ref.id, open), scope));
			const offered = catalog.map(refOf);
			yield* emit(open, [
				{kind: "mode", current: null, available: []},
				{kind: "model", current: currentOf(offered, running), available: offered},
				{kind: "thinking", current: thinking, available: levels},
				{kind: "phase", phase: "ready"},
			]);
			return {sessionId: ref.id};
		});

		const prompt = Effect.fn("TuvalAiAgent.prompt")(function* (text: string, key?: string) {
			const current = yield* Ref.get(session);
			if (current === null) {
				return yield* new PromptError({
					reason: "no-session",
					detail: "start has not opened a Pi session on this layer",
				});
			}
			if (key !== undefined) {
				if ((yield* Ref.get(keys)).has(key)) return;
				// Recorded at the send, not at the turn's end: the transport-level retry the key
				// exists for fires while the first send is still in flight (ruling 2, #7570), and a
				// key recorded after `pi.prompt` resolves could never see it.
				yield* Ref.update(keys, (seen) => new Set(seen).add(key));
			}
			const open = yield* Ref.get(queue);
			// The pin answers a `prompt` request with the snapshot the turn ended on, so awaiting it
			// here would return at the end of the turn rather than at the send — and the generic
			// host awaits a Cmd handler before it publishes the commit that handler came from, so
			// the operator's own message would not paint until the reply landed (#8018). Forked into
			// the layer's scope, this returns at the send, as the Claude layer's does. The turn's
			// own events are pushed by `follow` and nothing reads the snapshot this discards.
			yield* Effect.forkIn(
				pi.prompt(current.id, text).pipe(
					Effect.mapError(promptErrorOf),
					// A send that never landed is not a turn this session has seen, so the key goes
					// back and a retry of it is admitted.
					Effect.tapError(() => (key === undefined ? Effect.void : Ref.update(keys, without(key)))),
					// The refusal has no caller left to raise to, so it rides the stream the send's own
					// turn would have used. It rides it as an event, not as the queue's failure: a
					// failed queue is terminal and its Sub is never re-armed under the same id, so
					// ending it here would take every later turn's output with it (#8018). Only a
					// dead transport takes that exit, because for that one there is no later turn.
					Effect.catch((refusal) =>
						refusal.reason === "disconnected"
							? Queue.fail(open, promptDropOf(refusal))
							: emit(open, [{kind: "failure", failure: promptFailureOf(refusal)}]),
					),
					Effect.asVoid,
				),
				scope,
			);
		});

		const interrupt = Effect.gen(function* () {
			const current = yield* Ref.get(session);
			if (current === null) return;
			yield* pi.abort(current.id).pipe(
				Effect.asVoid,
				// `interrupt` declares no error channel, so a refused abort is a log line: the turn
				// the operator wanted stopped either already ended or the transport is gone, and
				// both are states the next event settles.
				Effect.catch((refusal) => Effect.logWarning(`interrupt was refused: ${refusal.message}`)),
			);
		}).pipe(Effect.withSpan("TuvalAiAgent.interrupt"));

		const setModel = Effect.fn("TuvalAiAgent.setModel")(function* (model: ModelRef) {
			const catalog = yield* pi.models;
			const picked = catalog.find((row) => sameModel(refOf(row), model));
			if (picked === undefined) {
				return yield* new ModelUnsupported({
					model: model.id,
					available: catalog.map((row) => row.id),
				});
			}
			const offered = catalog.map(refOf);
			const selection: ModelSelection = {provider: picked.provider, id: picked.id};
			const current = yield* Ref.get(session);
			if (current === null) {
				// No session yet is not "not offered". Refusing here answered `ModelUnsupported`
				// with the refused model listed among the available ones, which contradicts itself
				// (#7981); the pick is held instead and the next `start` opens on it.
				yield* Ref.set(pendingModel, selection);
				yield* announce(refOf(picked), offered);
				// The offered thinking set is the *model's*, so a pick made before any session exists
				// still moves the picker's rows to the ones that model will accept (#8062).
				return yield* announceThinking(null, levelsOf(catalog, selection));
			}
			const snapshot = yield* applySwitch(current.id, selection, current.model);
			yield* Ref.set(session, {...current, model: snapshot});
			yield* announce(currentOf(offered, snapshot), offered);
			// The level survives the model switch only if the new model offers it; otherwise the
			// picker is told the session is on nothing rather than on a level it would now refuse.
			const levels = levelsOf(catalog, snapshot);
			yield* announceThinking(
				levels.includes(current.thinkingLevel) ? current.thinkingLevel : null,
				levels,
			);
		});

		const setThinkingLevel = Effect.fn("TuvalAiAgent.setThinkingLevel")(function* (
			level: ThinkingLevel,
		) {
			const catalog = yield* pi.models;
			const current = yield* Ref.get(session);
			// Before a session exists there is no model to read an offered set off, so the pick is
			// held against the next open exactly as `setModel`'s is — "no session yet" is not
			// "not offered" here either (#7981).
			if (current === null) {
				const opening = (yield* Ref.get(pendingModel)) ?? options.model;
				const levels = opening === undefined ? [] : levelsOf(catalog, opening);
				if (opening !== undefined && !levels.includes(level)) {
					return yield* new ThinkingUnsupported({level, available: levels});
				}
				yield* Ref.set(pendingThinking, level);
				return yield* announceThinking(level, levels);
			}
			const levels = levelsOf(catalog, current.model);
			if (!levels.includes(level)) {
				return yield* new ThinkingUnsupported({level, available: levels});
			}
			const applied = yield* applyThinking(current.id, level, current.thinkingLevel);
			yield* Ref.set(session, {...current, thinkingLevel: applied});
			yield* announceThinking(applied, levels);
		});

		const page = Effect.fn("TuvalAiAgent.page")(function* (before: string | null, limit: number) {
			const current = yield* Ref.get(session);
			if (current === null) {
				return yield* new PageError({
					reason: "store-unreadable",
					detail: "start has not opened a Pi session on this layer",
				});
			}
			const entries = yield* readBranch(sessionDir(current.cwd), current.id, current.cwd);
			const planned = planTranscriptPage(pageItems(entries), {before, limit});
			if (isRefusal(planned)) {
				if (planned.reason === "limit-not-positive") {
					// The port declares `limit > 0`; a caller that broke it has a bug this
					// interface does not model, exactly as the scripted layer treats it.
					return yield* Effect.die(
						new Error(`page was asked for ${limit} items; the port declares limit > 0`),
					);
				}
				return yield* new PageError({reason: "unknown-cursor", detail: planned.reason});
			}
			return {items: planned.items, hasMore: planned.next !== null};
		});

		return {
			start,
			prompt,
			interrupt,
			// Pi raises no permission requests and offers no modes at this pin, so both refuse as
			// data: there is no request to answer and no mode to set.
			answer: (request: string, _decision: PermissionDecision) =>
				Effect.fail(new UnknownRequest({request})),
			setMode: (mode: Mode) => Effect.fail(new ModeUnsupported({mode, available: []})),
			setModel,
			setThinkingLevel,
			page,
			events: Stream.unwrap(Effect.map(Ref.get(queue), (open) => Stream.fromQueue(open))),
		};
	});

/**
 * The server and the client, in that order, as one layer. The dial URL carries the per-launch
 * token, so it is unwrapped here and nowhere else — the value goes straight into the transport
 * factory's closure and never onto a service surface, an event or a log line.
 */
const transport = (
	options: PiAiAgentOptions,
): Layer.Layer<PiClientService | PiServerService, ServerBindFailed, PiSessionHost> => {
	// `exactOptionalPropertyTypes` refuses an explicit `undefined` on an optional field, so an
	// absent option stays absent rather than being forwarded as one.
	const server = PiServerService.layer({
		...(options.host === undefined ? {} : {host: options.host}),
		...(options.limits === undefined ? {} : {limits: options.limits}),
	});
	const client = Layer.unwrap(
		Effect.gen(function* () {
			const running = yield* PiServerService;
			return PiClientService.layerWebSocket({url: Redacted.value(running.url)});
		}),
	);
	return Layer.provideMerge(client, server);
};

/**
 * Pi's model runtime and the session host over it, created inside this layer's own Scope.
 *
 * This is what keeps ruling 4's `R` empty. The call site supplies `authPath` and `modelsPath` and
 * nothing further, so the strings on `PiAiAgentOptions` are the whole of what a process gives Pi
 * and no Pi value ever crosses back out to it. `CreateModelRuntimeOptions` does declare three
 * options that are neither a path nor a flag — `credentials`, `modelsStore` and `signal` — and
 * leaving all three unset is what keeps this seam string-only at 0.84.3
 * (`dist/core/model-runtime.d.ts:3-18`). The two paths are Pi's own, rebased on `agentDir` so an
 * overridden directory moves the credentials and the catalog together
 * (`getAuthPath`/`getModelsPath` are `join(getAgentDir(), …)`, `dist/config.js:432-438`). The
 * runtime holds nothing to release — it declares no `dispose` or `close` — so it is created rather
 * than acquired.
 */
const host = (options: PiAiAgentOptions): Layer.Layer<PiSessionHost> =>
	Layer.unwrap(
		Effect.gen(function* () {
			const agentDir = options.agentDir ?? getAgentDir();
			const modelRuntime = yield* Effect.tryPromise({
				try: () =>
					ModelRuntime.create({
						authPath: join(agentDir, "auth.json"),
						modelsPath: join(agentDir, "models.json"),
					}),
				catch: (cause) => new ModelRuntimeUnavailable({agentDir, detail: String(cause)}),
			}).pipe(Effect.orDie);
			return agentSessionHostLayer({
				modelRuntime,
				agentDir,
				...(options.sessionDir === undefined ? {} : {sessionDir: options.sessionDir}),
				...(options.projectRoot === undefined ? {} : {projectRoot: options.projectRoot}),
			});
		}),
	);

/**
 * The mapping half alone, over a transport the caller already stood up.
 *
 * Not part of `PiAiAgent`: ruling 4 (#7570) gives this module one layer, and a second public one
 * whose requirement is a live `PiClientService` is a second shape a process could build. It stays
 * out of `index.ts` for that reason, and exists for the integration proof beside it, which needs
 * two agents over one server to see what the server does with a second claimant.
 */
export const aiAgentOverClient = (
	options: PiAiAgentOptions = {},
): Layer.Layer<TuvalAiAgent, never, PiClientService> => Layer.effect(TuvalAiAgent, make(options));

/**
 * Everything but the model runtime, over a `PiSessionHost` the caller stood up.
 *
 * The same test-only door as `aiAgentOverClient` and out of `index.ts` for the same reason: a
 * scripted or faux-provider host is the one injection a test cannot express in plain strings, since
 * `registerNativeProvider` takes a Pi provider. A process uses `PiAiAgent.layer`.
 */
export const aiAgentOverHost = (
	options: PiAiAgentOptions = {},
): Layer.Layer<TuvalAiAgent, never, PiSessionHost> =>
	Layer.effect(TuvalAiAgent, make(options)).pipe(Layer.provide(Layer.orDie(transport(options))));

export const PiAiAgent = {
	/**
	 * Ruling 4's layer (#7570): building it inside the process's Scope stands up Pi's model runtime,
	 * the session host, the loopback server and the client, and closing that Scope tears all four
	 * down. `R` is empty and `E` is `never`, so a process hands this to `aiAgentProgram` and holds no
	 * Pi value of its own. A bind failure dies rather than riding the error channel: the layer is
	 * built before any handler runs, so there is no caller to hand a `ServerBindFailed` to and
	 * nothing that could act on one — a loopback port this process cannot bind is a broken host, not
	 * a case the row models.
	 */
	layer: (options: PiAiAgentOptions = {}): Layer.Layer<TuvalAiAgent> =>
		aiAgentOverHost(options).pipe(Layer.provide(host(options))),
} as const;
