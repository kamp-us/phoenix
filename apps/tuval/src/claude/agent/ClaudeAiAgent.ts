/**
 * `ClaudeAiAgent` — the `TuvalAiAgent` layer over `@anthropic-ai/claude-agent-sdk`. The SDK's
 * `query` / `Query` / `SDKMessage` surface stops at this directory; everything this hands a caller
 * is a generic event or a port value.
 *
 * The layer is the subprocess's lifetime (founder ruling 4, #7570). Building it stands up the
 * in-process tool server over `KernelBridge` and the Effect runtime its handlers run on; `start`
 * opens the one `query()` that owns the Claude Code subprocess, and closing the Scope calls
 * `Query.close()` — which "terminates the underlying process" (`sdk.d.ts`) — exactly once and
 * resolves every parked permission as denied, so nothing is left blocked on an answer that will
 * never come.
 *
 * One `query()`, many turns: the prompt is an `AsyncIterable<SDKUserMessage>`, which is both what
 * makes the session streaming-input (the precondition `Query.interrupt` and
 * `Query.setPermissionMode` declare) and the input path the SDK drives through `Query.streamInput`
 * (`input.ts`).
 *
 * There is no reconnect and no respawn. A subprocess that goes before its turn produced a `result`
 * fails `events` once with a `TransportError` and nothing dials again; retry policy is the machine's
 * declared data (#7371), and the way back in is another `start({cwd, resume: sessionId})`.
 *
 * The pending permission map is a plain `Map` rather than a `Ref`. `canUseTool` is called by the
 * SDK on no fiber of ours and must have parked its resolver before it returns, so the registration
 * has to be synchronous — a `Ref.update` scheduled onto a fiber can lose the race with the abort
 * signal that fires immediately after. Every mutation of it is synchronous, which on one JS thread
 * is the same atomicity a `Ref` would buy.
 */

import type {
	PermissionMode,
	PermissionResult,
	PermissionUpdate,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {type Cause, Effect, Exit, Layer, Queue, Ref, Scope, Stream} from "effect";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {isRefusal, planTranscriptPage} from "../../ai-agent/history/index.ts";
import type {
	Mode,
	PermissionDecision,
	PermissionRequest,
	TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import {
	ModeUnsupported,
	type StartError,
	type TransportError,
	TuvalAiAgent,
	type TuvalAiAgentApi,
	UnknownRequest,
} from "../../ai-agent/service/index.ts";
import {emptyMapping, type Mapping, toAgentEvents, toHistoryItems} from "../history/index.ts";
import {KernelBridge, type ToolRuntime, tuvalToolServer} from "../tools/index.ts";
import {cardOf, resultOf} from "./cards.ts";
import {type InputChannel, inputChannel, userMessage} from "./input.ts";
import {
	advertisedModes,
	type ClaudeAiAgentOptions,
	openingMode,
	queryOptionsOf,
	sessionEnv,
} from "./options.ts";
import {
	controlRefused,
	noSession,
	noSessionToPage,
	promptDisconnected,
	sessionNotFound,
	startTransport,
	startWithoutInit,
	storeUnreadable,
	streamFailed,
	subprocessGone,
	unknownCursor,
} from "./refusals.ts";
import {type AgentSession, realAgentSdk} from "./sdk.ts";
import {exitDetail, type SubprocessWatch, watchSubprocess} from "./subprocess.ts";

type EventQueue = Queue.Queue<AgentEvent, TransportError | Cause.Done>;

/** One prompt the SDK is blocked on: the resolver to call, and the rules an "always" would install. */
interface Parked {
	readonly resolve: (result: PermissionResult) => void;
	readonly suggestions: ReadonlyArray<PermissionUpdate>;
}

/**
 * Whether this session owes a `result`, and whether the layer asked it to stop. Together they are
 * what tells a deliberate teardown from a subprocess that died mid-turn — the generator ends the
 * same way in both cases.
 */
interface TurnState {
	settled: boolean;
	closing: boolean;
}

interface Session {
	readonly id: string;
	readonly cwd: string;
	readonly handle: AgentSession;
	readonly input: InputChannel;
	readonly watch: SubprocessWatch | null;
	readonly state: TurnState;
	/**
	 * The pump's scope, which is this session's and not the layer's.
	 *
	 * The pump blocks awaiting `iterator.next()`, and that await is not interruptible — nothing
	 * aborts a running async generator. What ends it is `Query.close()`,
	 * which ends the generator. So the fiber is forked into a scope the teardown closes *after*
	 * that call rather than into the layer's, whose finalizers would otherwise interrupt-and-await
	 * a fiber still waiting on a subprocess nobody had told to stop.
	 */
	readonly scope: Scope.Closeable;
}

/** One message off the query, as three outcomes rather than an error channel. */
type Pulled =
	| {readonly kind: "message"; readonly message: SDKMessage}
	| {readonly kind: "done"}
	| {readonly kind: "failed"; readonly error: TransportError};

/**
 * The next message, as a value rather than a channel. Both callers have to tell "the session ended"
 * from "the iterator threw" and act differently on each, so neither is an error here.
 */
const pull = (iterator: AsyncIterator<SDKMessage>): Effect.Effect<Pulled> =>
	Effect.tryPromise({
		try: () => iterator.next(),
		catch: streamFailed,
	}).pipe(
		Effect.map(
			(step): Pulled =>
				step.done === true ? {kind: "done"} : {kind: "message", message: step.value},
		),
		Effect.catch((error) => Effect.succeed<Pulled>({kind: "failed", error})),
	);

const isInit = (
	message: SDKMessage,
): message is Extract<SDKMessage, {type: "system"; subtype: "init"}> =>
	message.type === "system" && message.subtype === "init";

const without =
	(key: string) =>
	(seen: ReadonlySet<string>): ReadonlySet<string> => {
		const next = new Set(seen);
		next.delete(key);
		return next;
	};

/** The tool calls a stored session opened and never settled — the only cards a window can still hold. */
const unsettledToolIds = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
	items.flatMap((item) => (item.kind === "tool" && item.status === "running" ? [item.id] : []));

const make = (
	options: ClaudeAiAgentOptions,
): Effect.Effect<TuvalAiAgentApi, never, Scope.Scope | KernelBridge> =>
	Effect.gen(function* () {
		const bridge = yield* KernelBridge;
		const services = yield* Effect.context<never>();
		const sdk = options.sdk ?? realAgentSdk;
		const available = advertisedModes(options);

		// The handlers are plain `async` functions the SDK calls; Effect runs inside them, over the
		// services this layer was built with, so a tool call keeps the caller's spans and loggers
		// (spike #7597 finding 2).
		const runtime: ToolRuntime = {runPromise: Effect.runPromiseWith(services)};
		const server = tuvalToolServer(bridge, runtime);

		const queue = yield* Ref.make<EventQueue>(
			yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>(),
		);
		const session = yield* Ref.make<Session | null>(null);
		const keys = yield* Ref.make<ReadonlySet<string>>(new Set());
		const mode = yield* Ref.make<Mode | null>(null);
		const parked = new Map<string, Parked>();

		const emit = (open: EventQueue, events: ReadonlyArray<AgentEvent>): Effect.Effect<void> =>
			// Serial: one subscription, one ordering — a parallel offer would shuffle a turn.
			Effect.forEach(events, (event) => Queue.offer(open, event), {concurrency: 1, discard: true});

		const publish = (events: ReadonlyArray<AgentEvent>): Effect.Effect<void> =>
			Effect.flatMap(Ref.get(queue), (open) => emit(open, events));

		/** Answering one parked prompt. `false` means nothing was parked under that id. */
		const settle = (request: string, decision: PermissionDecision): Effect.Effect<boolean> =>
			Effect.suspend(() => {
				const held = parked.get(request);
				if (held === undefined) return Effect.succeed(false);
				parked.delete(request);
				held.resolve(resultOf(decision, held.suggestions));
				return Effect.as(publish([{kind: "permission-resolved", request, decision}]), true);
			});

		const denyEveryParked = Effect.suspend(() =>
			// Serial for the same reason `emit` is: each settle publishes, and one subscription has
			// one ordering.
			Effect.forEach([...parked.keys()], (request) => settle(request, "deny"), {
				concurrency: 1,
				discard: true,
			}),
		);

		/**
		 * Tear the current session down, at most once. `Ref.getAndSet` is the whole exclusion: the
		 * lane that takes the session non-null is the lane that closes it, so `Query.close()` runs
		 * exactly once however many times a scope close and a re-`start` race.
		 */
		const closeCurrent: Effect.Effect<void> = Effect.gen(function* () {
			const held = yield* Ref.getAndSet(session, null);
			if (held === null) return;
			held.state.closing = true;
			yield* Effect.sync(() => {
				held.input.end();
				held.handle.close();
			});
			// Only now: the generator has ended, so the pump's next pull resolves and the fiber this
			// closes is finishing rather than blocked.
			yield* Scope.close(held.scope, Exit.void);
			yield* denyEveryParked;
		});

		yield* Effect.addFinalizer(() =>
			closeCurrent.pipe(Effect.andThen(Effect.flatMap(Ref.get(queue), Queue.shutdown))),
		);

		const canUseTool = (
			toolName: string,
			input: Record<string, unknown>,
			context: {
				readonly signal: AbortSignal;
				readonly toolUseID: string;
				readonly suggestions?: ReadonlyArray<PermissionUpdate> | undefined;
				readonly title?: string | undefined;
				readonly displayName?: string | undefined;
				readonly description?: string | undefined;
				readonly decisionReason?: string | undefined;
				readonly blockedPath?: string | undefined;
				readonly matchedAskRule?:
					| {readonly source: string; readonly ruleContent?: string}
					| undefined;
			},
		): Promise<PermissionResult> =>
			new Promise<PermissionResult>((resolve) => {
				const request = context.toolUseID;
				const card: PermissionRequest = cardOf(toolName, input, context);
				const onAbort = (): void => {
					void runtime.runPromise(settle(request, "deny"));
				};
				parked.set(request, {
					resolve: (result) => {
						context.signal.removeEventListener("abort", onAbort);
						resolve(result);
					},
					suggestions: context.suggestions ?? [],
				});
				context.signal.addEventListener("abort", onAbort, {once: true});
				void runtime.runPromise(publish([{kind: "permission", request, detail: card}]));
			});

		const drive = (
			open: EventQueue,
			iterator: AsyncIterator<SDKMessage>,
			started: Mapping,
			current: Session,
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				let mapping = started;
				while (true) {
					const pulled = yield* pull(iterator);
					if (pulled.kind === "failed") {
						yield* Queue.fail(open, pulled.error);
						return;
					}
					if (pulled.kind === "done") {
						const clean = current.state.closing || current.state.settled;
						yield* clean
							? Queue.end(open)
							: Queue.fail(open, subprocessGone(exitDetail(current.watch?.exit() ?? null)));
						return;
					}
					const step = toAgentEvents(pulled.message, mapping, {at: Date.now()});
					mapping = step.mapping;
					yield* emit(open, step.events);
					if (pulled.message.type === "result") current.state.settled = true;
				}
			});

		/**
		 * Open the session and read it up to its `init`, which is the only frame that names the
		 * session id. The frames read on the way are the session's first events and are handed back
		 * rather than dropped.
		 */
		const open = Effect.fn("TuvalAiAgent.start.open")(function* (
			cwd: string,
			resume: string | undefined,
			out: EventQueue,
			held: Mode | null,
		) {
			const stale: Array<string> = [];
			if (resume !== undefined) {
				const rows = yield* Effect.tryPromise({
					try: () => sdk.getSessionMessages(resume, {dir: cwd}),
					catch: (cause) => startTransport(cwd, cause),
				});
				// "Returns an array of messages, or an empty array if the session was not found"
				// (`sdk.d.ts`, `getSessionMessages`) — the miss itself, with no error text to scrape.
				if (rows.length === 0) return yield* sessionNotFound(cwd, resume);
				const {items} = toHistoryItems(rows, {at: Date.now()});
				stale.push(...unsettledToolIds(items).filter((id) => !parked.has(id)));
			}

			const watch = options.spawn === undefined ? null : watchSubprocess(options.spawn);
			const input = inputChannel();
			const handle = yield* Effect.try({
				try: () =>
					sdk.query({
						prompt: input.messages,
						options: queryOptionsOf(options, {
							cwd,
							server,
							canUseTool,
							env: sessionEnv(),
							held,
							...(resume === undefined ? {} : {resume}),
							...(watch === null ? {} : {spawn: watch.spawn}),
						}),
					}),
				catch: (cause) => startTransport(cwd, cause),
			});
			const abandon = Effect.sync(() => {
				input.end();
				handle.close();
			});

			const iterator = handle[Symbol.asyncIterator]();
			const first: Array<AgentEvent> = [];
			let mapping = emptyMapping;
			while (true) {
				const pulled = yield* pull(iterator);
				if (pulled.kind === "failed") {
					yield* abandon;
					return yield* startTransport(cwd, pulled.error.detail);
				}
				if (pulled.kind === "done") {
					yield* abandon;
					return yield* startWithoutInit(cwd, exitDetail(watch?.exit() ?? null));
				}
				const step = toAgentEvents(pulled.message, mapping, {at: Date.now()});
				mapping = step.mapping;
				first.push(...step.events);
				if (!isInit(pulled.message)) continue;

				const current: Session = {
					id: pulled.message.session_id,
					cwd,
					handle,
					input,
					watch,
					state: {settled: false, closing: false},
					scope: yield* Scope.make(),
				};
				// The one line that makes SDK/CLI drift visible: the pin is ours, the CLI is whatever
				// is on PATH, and nothing else in the run reports the pair (founder ruling on #7580).
				yield* Effect.logInfo(
					`claude session ${current.id} opened — SDK ${sdk.version}, CLI ${pulled.message.claude_code_version}`,
				);
				yield* emit(out, first);
				return {session: current, iterator, mapping, stale: stale as ReadonlyArray<string>};
			}
		});

		const start = Effect.fn("TuvalAiAgent.start")(function* (startOptions: {
			readonly cwd: string;
			readonly resume?: string;
		}) {
			const previous = yield* Ref.get(session);
			// A second `start` is a reconnect, and it replaces the session whole: the previous
			// subprocess is closed, its pump ended with it, and the old queue is shut so a
			// subscription taken before this call is not resurrected.
			yield* closeCurrent;
			yield* Effect.flatMap(Ref.get(queue), Queue.shutdown);

			const out = yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>();
			yield* Ref.set(queue, out);
			yield* emit(out, [{kind: "phase", phase: "starting"}]);

			const held = yield* Ref.get(mode);
			// One stream carries everything (ruling 1, #7570), so a failed start owes it a terminal
			// phase: without this every subscriber sits on `starting` for the life of the layer.
			const opened = yield* open(startOptions.cwd, startOptions.resume, out, held).pipe(
				Effect.tapError((_error: StartError) => emit(out, [{kind: "phase", phase: "gone"}])),
			);

			yield* Ref.set(session, opened.session);
			// The keys belong to a session, not to the layer: a key is dropped when this *session* has
			// seen it, so a new session admits one the previous session spent. Resuming the session the
			// keys were recorded under is the one case that keeps them.
			const continuing = previous !== null && startOptions.resume === previous.id;
			if (!continuing) yield* Ref.set(keys, new Set<string>());
			// Forked into the session's own scope, so the fan lives exactly as long as the
			// subprocess it reads and dies with it.
			yield* Effect.forkIn(
				drive(out, opened.iterator, opened.mapping, opened.session),
				opened.session.scope,
			);

			// The announced mode is resolved by the same call `open` opened the query with, never the
			// raw `held`: `held` is null until an operator calls `setMode`, so a row carrying any
			// non-default `permissionMode` would run on that mode and tell every subscriber it has
			// none — a `current: null` beside a non-empty `available` is not a state `ModePayload`
			// defines (#7828).
			yield* emit(out, [{kind: "mode", current: openingMode(options, held) as Mode, available}]);
			// A card the layer does not hold cannot be answered, so a window restored with one would
			// wedge on it. Resolving it is what lets the generic restore drop it (#7608).
			yield* emit(
				out,
				opened.stale.map(
					(request) => ({kind: "permission-resolved", request, decision: "deny"}) as const,
				),
			);
			return {sessionId: opened.session.id};
		});

		const prompt = Effect.fn("TuvalAiAgent.prompt")(function* (text: string, key?: string) {
			const current = yield* Ref.get(session);
			if (current === null) return yield* noSession();
			if (key !== undefined) {
				if ((yield* Ref.get(keys)).has(key)) return;
				// Recorded at the send, not at the turn's end: the transport-level retry the key
				// exists for fires while the first send is still in flight (ruling 2, #7570).
				yield* Ref.update(keys, (seen) => new Set(seen).add(key));
			}
			yield* Effect.try({
				try: () => {
					current.state.settled = false;
					current.input.push(userMessage(current.id, text));
				},
				catch: promptDisconnected,
			}).pipe(
				// A send that never landed is not a turn this session has seen, so the key goes back
				// and a retry of it is admitted.
				Effect.tapError(() => (key === undefined ? Effect.void : Ref.update(keys, without(key)))),
			);
		});

		const interrupt = Effect.gen(function* () {
			const current = yield* Ref.get(session);
			if (current === null) return;
			yield* Effect.tryPromise({
				try: () => current.handle.interrupt(),
				catch: controlRefused,
			}).pipe(
				Effect.asVoid,
				// `interrupt` declares no error channel, so a refused interrupt is a log line: the
				// turn the operator wanted stopped either already ended or the subprocess is gone,
				// and both are states the next event settles.
				Effect.catch((refusal) => Effect.logWarning(`interrupt was refused: ${refusal.detail}`)),
			);
		}).pipe(Effect.withSpan("TuvalAiAgent.interrupt"));

		const answer = Effect.fn("TuvalAiAgent.answer")(function* (
			request: string,
			decision: PermissionDecision,
		) {
			if (yield* settle(request, decision)) return;
			return yield* new UnknownRequest({request});
		});

		const setMode = Effect.fn("TuvalAiAgent.setMode")(function* (next: Mode) {
			if (!available.includes(next)) {
				return yield* new ModeUnsupported({mode: next, available});
			}
			const current = yield* Ref.get(session);
			const changed =
				current === null
					? true
					: yield* Effect.tryPromise({
							try: () => current.handle.setPermissionMode(next as PermissionMode),
							catch: controlRefused,
						}).pipe(
							Effect.as(true),
							// The error channel declares only `ModeUnsupported`, and a refused switch is
							// not that: the mode did not change, so the state is re-emitted unchanged
							// rather than a lie being put on the stream.
							Effect.catch((refusal) =>
								Effect.as(
									Effect.logWarning(`the mode switch was refused: ${refusal.detail}`),
									false,
								),
							),
						);
			if (changed) yield* Ref.set(mode, next);
			const held = yield* Ref.get(mode);
			yield* publish([{kind: "mode", current: held, available}]);
		});

		const page = Effect.fn("TuvalAiAgent.page")(function* (before: string | null, limit: number) {
			const current = yield* Ref.get(session);
			if (current === null) return yield* noSessionToPage();
			const rows = yield* Effect.tryPromise({
				try: () => sdk.getSessionMessages(current.id, {dir: current.cwd}),
				catch: storeUnreadable,
			});
			const {items} = toHistoryItems(rows, {at: Date.now()});
			const planned = planTranscriptPage(items, {before, limit});
			if (isRefusal(planned)) {
				if (planned.reason === "limit-not-positive") {
					// The port declares `limit > 0`; a caller that broke it has a bug this interface
					// does not model, exactly as the scripted layer treats it.
					return yield* Effect.die(
						new Error(`page was asked for ${limit} items; the port declares limit > 0`),
					);
				}
				return yield* unknownCursor(planned.reason);
			}
			return {items: planned.items, hasMore: planned.next !== null};
		});

		return {
			start,
			prompt,
			interrupt,
			answer,
			setMode,
			page,
			events: Stream.unwrap(Effect.map(Ref.get(queue), (held) => Stream.fromQueue(held))),
		};
	});

export const ClaudeAiAgent = {
	/**
	 * Ruling 4's layer (#7570). `KernelBridge` is the one thing it needs and the row provides it, so
	 * a process hands the composed layer to `aiAgentProgram` and holds no SDK value of its own. The
	 * build Scope is the subprocess's lifetime and is owned by `Layer.effect`, which is why it does
	 * not appear in the requirement.
	 */
	layer: (options: ClaudeAiAgentOptions): Layer.Layer<TuvalAiAgent, never, KernelBridge> =>
		Layer.effect(TuvalAiAgent, make(options)),
} as const;
