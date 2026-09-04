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
 * subscription taken after the re-`start` is live, and one taken before is not resurrected.
 *
 * Pi offers no permission prompts and no modes at this pin, so `permission` emits nothing, `mode`
 * advertises an empty list, and `answer` and `setMode` refuse as data rather than throwing.
 */

import {readdirSync} from "node:fs";
import {join} from "node:path";
import {getAgentDir, ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {type Cause, Effect, Fiber, Layer, Queue, Redacted, Ref, type Scope, Stream} from "effect";
import {isRefusal, planTranscriptPage} from "../../ai-agent/history/index.ts";
import type {Mode, PermissionDecision} from "../../ai-agent/ports/index.ts";
import {
	type AgentEvent,
	ModeUnsupported,
	PageError,
	PromptError,
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
import {promptErrorOf, startErrorOf, storeUnreadable, transportErrorOf} from "./refusals.ts";

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
				return options_.resume === undefined
					? yield* pi.createSession(
							options_.cwd,
							options.model === undefined ? {} : {model: options.model},
						)
					: yield* pi.attachSession(options_.resume);
			}).pipe(Effect.mapError((refusal) => startErrorOf(options_.cwd, refusal)));

			// One stream carries everything (ruling 1, #7570), so a failed start owes it a terminal
			// phase: without this every subscriber sits on `starting` for the life of the layer.
			const ref = yield* acquire.pipe(
				Effect.tapError(() => emit(open, [{kind: "phase", phase: "gone"}])),
			);

			yield* Ref.set(session, ref);
			// Forked into the layer's own scope, not the caller's, so the fan lives exactly as long
			// as the transport it reads and dies with it.
			yield* Ref.set(pump, yield* Effect.forkIn(follow(ref.id, open), scope));
			yield* emit(open, [
				{kind: "mode", current: null, available: []},
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
			// The pin answers a `prompt` request with the snapshot the turn ended on, so this
			// resolves at the end of the turn rather than at the send. The events the turn produced
			// have already been pushed and folded by then; nothing waits on this returning.
			yield* pi.prompt(current.id, text).pipe(
				Effect.mapError(promptErrorOf),
				// A send that never landed is not a turn this session has seen, so the key goes
				// back and a retry of it is admitted.
				Effect.tapError(() => (key === undefined ? Effect.void : Ref.update(keys, without(key)))),
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
 * This is what keeps ruling 4's `R` empty. `ModelRuntime.create` takes plain paths and flags and
 * nothing else at 0.84.3 (`CreateModelRuntimeOptions`, `dist/core/model-runtime.d.ts:3-18`), so the
 * strings on `PiAiAgentOptions` are the whole of what a process supplies and no Pi value ever
 * crosses back out to it. The two paths are Pi's own, rebased on `agentDir` so an overridden
 * directory moves the credentials and the catalog together (`getAuthPath`/`getModelsPath` are
 * `join(getAgentDir(), …)`, `dist/config.js:432-438`). The runtime holds nothing to release — it
 * declares no `dispose` or `close` — so it is created rather than acquired.
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
