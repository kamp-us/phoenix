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

import {randomUUID} from "node:crypto";
import type {
	EffortLevel,
	ModelInfo,
	PermissionMode,
	PermissionResult,
	PermissionUpdate,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {type Cause, Effect, Exit, Layer, Queue, Ref, Scope, Stream} from "effect";
import type {AgentAccount, AgentEvent} from "../../ai-agent/events.ts";
import {isRefusal, planTranscriptPage} from "../../ai-agent/history/index.ts";
import type {
	CommandRef,
	Mode,
	ModelRef,
	PermissionDecision,
	PermissionRequest,
	ThinkingLevel,
	TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import {sameModel} from "../../ai-agent/ports/index.ts";
import {
	ModelUnsupported,
	ModeUnsupported,
	type StartError,
	type StartOptions,
	ThinkingUnsupported,
	type TranscriptQuery,
	type TransportError,
	TuvalAiAgent,
	type TuvalAiAgentApi,
	UnknownRequest,
} from "../../ai-agent/service/index.ts";
import {withTurnResult} from "../../ai-agent/turn-result.ts";
import {
	commandsOf,
	emptyMapping,
	type Mapping,
	toAgentEvents,
	toHistoryItems,
} from "../history/index.ts";
import {KernelBridge, type ToolRuntime, tuvalToolServer} from "../tools/index.ts";
import {cardOf, resultOf} from "./cards.ts";
import {type InputChannel, inputChannel, userMessage} from "./input.ts";
import {
	advertisedModes,
	type ClaudeAiAgentOptions,
	openingMode,
	queryOptionsOf,
	type SessionChoice,
	sessionEnv,
} from "./options.ts";
import {
	controlRefused,
	interruptFailureOf,
	logRefused,
	noSession,
	noSessionToPage,
	promptDisconnected,
	sessionNotFound,
	startStoreUnreadable,
	startTransport,
	startWithoutHandshake,
	storeUnlistable,
	storeUnreadable,
	streamFailed,
	subprocessGone,
	transcriptSessionNotFound,
	transcriptUnknownCursor,
	transcriptUnreadable,
	unknownCursor,
} from "./refusals.ts";
import {type AgentSession, realAgentSdk} from "./sdk.ts";
import {claudeSessions} from "./sessions.ts";
import {readSubagentTranscript} from "./sidechain-store.ts";
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

/** Whether the `system`/`init` frame has been read yet. It arrives once per turn; this logs once. */
interface IntroState {
	seen: boolean;
}

interface Session {
	/**
	 * The conversation this session is keyed on — what a prompt is stamped with and what every
	 * store read names.
	 *
	 * Rewritten in place, not readonly, because the CLI can re-key a live session: a
	 * `conversation_reset` ends one conversation and opens another under `new_conversation_id`
	 * (`sdk.d.ts` at the pin). `drive`, `prompt` and `page` all read the one held `Session`, so the
	 * pump writing the new id here is what makes the next prompt land in the conversation the
	 * operator is looking at (#8197). Replacing the whole record instead would leave `drive` on the
	 * copy it closed over.
	 */
	id: string;
	readonly cwd: string;
	readonly handle: AgentSession;
	readonly input: InputChannel;
	readonly watch: SubprocessWatch | null;
	readonly state: TurnState;
	readonly intro: IntroState;
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
		const model = yield* Ref.make<ModelRef | null>(null);
		// Only an operator pick survives as an override; a discovered default is read afresh. The
		// pick is recorded whether or not a session exists, and `start` re-applies it against the
		// catalog it reads (#8061).
		const pickedModel = yield* Ref.make<ModelRef | null>(null);
		// The session's catalog, and it dies with the session: `closeCurrent` empties it, so a pick
		// made between sessions is never judged against rows the dead session offered (#8061).
		const models = yield* Ref.make<ReadonlyArray<ModelRef>>([]);
		const commands = yield* Ref.make<ReadonlyArray<CommandRef>>([]);
		// The effort axis is per model — `ModelInfo` carries `supportedEffortLevels` per row — so the
		// offered set is looked up by the model the session is running on rather than held flat. It
		// dies with the session beside `models`, for the same reason (#8542).
		const efforts = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<EffortLevel>>>(new Map());
		// A `ThinkingLevel` rather than an `EffortLevel`, because a pick made with no session is held
		// unvalidated: the two levels Claude has no effort for are refused by the next open's
		// re-check, not by the setter that could only refuse them against an empty offer (#8542).
		const effort = yield* Ref.make<ThinkingLevel | null>(null);
		const parked = new Map<string, Parked>();

		const emit = (open: EventQueue, events: ReadonlyArray<AgentEvent>): Effect.Effect<void> =>
			// Serial: one subscription, one ordering — a parallel offer would shuffle a turn.
			Effect.forEach(events, (event) => Queue.offer(open, event), {concurrency: 1, discard: true});

		const publish = (events: ReadonlyArray<AgentEvent>): Effect.Effect<void> =>
			Effect.flatMap(Ref.get(queue), (open) => emit(open, events));

		/**
		 * The session's own catalog, read once per open. A CLI that cannot answer it leaves the list
		 * empty rather than failing the open: an absent picker is a session you can still prompt,
		 * and the composer disables the control on a list shorter than two anyway.
		 */
		const readCatalog = (current: Session): Effect.Effect<ReadonlyArray<ModelInfo>> =>
			Effect.tryPromise({
				try: () => current.handle.supportedModels(),
				catch: controlRefused,
			}).pipe(
				Effect.map((rows) => [...rows]),
				Effect.catch((refusal) =>
					Effect.as(
						logRefused("the model catalog could not be read", refusal),
						[] as ReadonlyArray<ModelInfo>,
					),
				),
			);

		/**
		 * The session's slash commands, read once per open. A CLI that cannot answer leaves the picker
		 * empty rather than failing the open, exactly as the model catalog does.
		 */
		const readCommands = (current: Session): Effect.Effect<ReadonlyArray<CommandRef>> =>
			Effect.tryPromise({
				try: () => current.handle.supportedCommands(),
				catch: controlRefused,
			}).pipe(
				Effect.map(commandsOf),
				Effect.catch((refusal) =>
					Effect.as(
						logRefused("the command catalog could not be read", refusal),
						[] as ReadonlyArray<CommandRef>,
					),
				),
			);

		const refOf = (row: ModelInfo): ModelRef => ({id: row.value, name: row.displayName});

		const readRunningModel = (current: Session): Effect.Effect<string | undefined> =>
			Effect.tryPromise({
				try: () => current.handle.getContextUsage({detail: "summary"}),
				catch: controlRefused,
			}).pipe(
				Effect.map((usage) => usage.model),
				Effect.catch((refusal) =>
					Effect.as(logRefused("the running model could not be read", refusal), undefined),
				),
			);

		/**
		 * The levels one row offers, and the founder's ruling in one line (#8062): Claude's effort
		 * axis has five levels and neither `off` nor `minimal`, and the picker shows exactly those
		 * five rather than mapping the missing two onto something. A row that does not support
		 * effort offers none.
		 */
		const effortsOf = (
			rows: ReadonlyArray<ModelInfo>,
		): ReadonlyMap<string, ReadonlyArray<EffortLevel>> =>
			new Map(rows.map((row) => [row.value, row.supportedEffortLevels ?? []]));

		const offeredEfforts = (
			table: ReadonlyMap<string, ReadonlyArray<EffortLevel>>,
			current: ModelRef | null,
		): ReadonlyArray<EffortLevel> => (current === null ? [] : (table.get(current.id) ?? []));

		const publishThinking = (
			current: ThinkingLevel | null,
			offered: ReadonlyArray<EffortLevel>,
		): Effect.Effect<void> => publish([{kind: "thinking", current, available: offered}]);

		/** The live switch. `false` is a refusal the caller keeps the old value over. */
		const applyEffort = (current: Session, next: EffortLevel): Effect.Effect<boolean> =>
			Effect.tryPromise({
				try: () => current.handle.applyFlagSettings({effortLevel: next}),
				catch: controlRefused,
			}).pipe(
				Effect.as(true),
				Effect.catch((refusal) =>
					Effect.as(logRefused("the effort switch was refused", refusal), false),
				),
			);

		/** The live switch. `false` is a refusal the caller keeps the old value over. */
		const applyModel = (current: Session, next: ModelRef): Effect.Effect<boolean> =>
			Effect.tryPromise({
				try: () => current.handle.setModel(next.id),
				catch: controlRefused,
			}).pipe(
				Effect.as(true),
				Effect.catch((refusal) =>
					Effect.as(logRefused("the model switch was refused", refusal), false),
				),
			);

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
			// Both catalogs were read off this session, so both go with it: kept, either would still
			// be the set a pick is judged against after the session offering it is gone (#8061,
			// #8542). The held selections stay — a pick is the operator's, not the session's, and the
			// next open re-validates it (#7981). Announcing the clear is `start`'s, because this
			// queue is shut the moment this returns; see the emit behind its `starting`.
			yield* Ref.set(models, []);
			yield* Ref.set(efforts, new Map());
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

		/**
		 * The two `AccountInfo` fields the desk shows, or `null` when the handshake carried neither.
		 *
		 * `email` is on that type and is never read here: the founder ruled organization and plan
		 * only (#8649). Every field of it is optional at the `0.3.259` pin, and `apiProvider`'s own
		 * doc comment says why — for a third-party provider "the other fields are absent and auth is
		 * external" — so a settled handshake is not the same as a known account, and one carrying
		 * neither field announces nothing rather than an empty row.
		 */
		const accountOf = (handshake: {
			readonly account?: {readonly organization?: string; readonly subscriptionType?: string};
		}): AgentAccount | null => {
			const organization = handshake.account?.organization;
			const subscriptionType = handshake.account?.subscriptionType;
			if (organization === undefined && subscriptionType === undefined) return null;
			return {
				...(organization === undefined ? {} : {organization}),
				...(subscriptionType === undefined ? {} : {subscriptionType}),
			};
		};

		/**
		 * The first `init` frame of a session, which is the first turn's rather than the open's.
		 *
		 * It carries the two values the handshake does not — `SDKControlInitializeResponse` declares
		 * neither `session_id` nor `claude_code_version` (`sdk.d.ts`) — so the drift line is written
		 * here. The id is checked rather than adopted: the layer told the CLI which session to open
		 * (`--session-id`), the events Sub and every later store read are keyed on it, and a CLI that
		 * named a different one has broken the resume path silently.
		 */
		const readIntro = (
			current: Session,
			message: Extract<SDKMessage, {type: "system"; subtype: "init"}>,
		): Effect.Effect<void> =>
			Effect.suspend(() => {
				if (current.intro.seen) return Effect.void;
				current.intro.seen = true;
				const line = Effect.logInfo(
					`claude session ${message.session_id} opened — SDK ${sdk.version}, CLI ${message.claude_code_version}`,
				);
				return message.session_id === current.id
					? line
					: Effect.andThen(
							line,
							Effect.logWarning(
								`the CLI opened session ${message.session_id}, not the ${current.id} this session is keyed on`,
							),
						);
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
					if (isInit(pulled.message)) yield* readIntro(current, pulled.message);
					const step = toAgentEvents(pulled.message, mapping, {at: Date.now()});
					mapping = step.mapping;
					// The SDK's `commands_changed` push carries the whole list, so the cached one is
					// replaced by it rather than merged into — reading it off the mapped event keeps one
					// path for the catalog whatever produced it.
					const pushed = step.events.findLast((event) => event.kind === "commands");
					if (pushed !== undefined) yield* Ref.set(commands, pushed.available);
					// Before the emit, not after: the event this frame carries walks the core back to
					// `ready`, and a queued prompt is admitted on that same commit — so the id has to
					// be the new conversation's by the time `prompt` reads it (#8197). The turn is
					// over too, exactly as a `result`'s is, and no `result` is coming for it.
					if (pulled.message.type === "conversation_reset") {
						current.state.settled = true;
						current.id = pulled.message.new_conversation_id;
					}
					yield* emit(open, step.events);
					if (pulled.message.type === "result") {
						current.state.settled = true;
						// A turn's end is the layer's to narrate, and `result` is where it lands:
						// `SDKResultMessage` is "the outcome of a turn … treat it as the turn-complete
						// signal" (`sdk.d.ts`). The discriminant is the whole test, so every
						// `SDKResultError` subtype ends the turn exactly as a success does — a failed
						// turn that stayed at `prompting` would refuse every later prompt (#7963).
						// After `step.events`, so the turn's own spend or failure line precedes it.
						yield* emit(open, [{kind: "phase", phase: "ready"}]);
					}
				}
			});

		/**
		 * Whether the CLI's store holds a session at all — the pinned existence check, asked only
		 * where a transcript read came back empty.
		 *
		 * At `0.3.259` `getSessionMessages` "returns Array of messages, or empty array if the session
		 * was not found" (`sdk.d.ts`), so an empty read is two answers in one and settles neither: an
		 * existing session with no rows and an id nobody stored read the same. `listSessions` is the
		 * one that distinguishes them — with no options it is the whole store, the same call and the
		 * same reason as `listSessions` below.
		 *
		 * The failure mapper is the caller's because the two callers refuse on different channels —
		 * `start` owes a `StartError`, the store read a `TranscriptError` — and neither may read a
		 * store that would not open as a session that is not there (#8131).
		 */
		const storeHolds = <E>(sessionId: string, unreadable: (cause: unknown) => E) =>
			Effect.map(Effect.tryPromise({try: () => sdk.listSessions(), catch: unreadable}), (stored) =>
				stored.some((info) => info.sessionId === sessionId),
			);

		/**
		 * Open the session, and wait for the CLI's connect-time handshake rather than for a message.
		 *
		 * Nothing is read off the message iterator here. In streaming-input mode every frame belongs
		 * to a turn, `init` included, and there is no turn before a prompt — so an open that waited
		 * for `init` waited for a prompt the machine would not let anyone send, which is the deadlock
		 * this replaces (#7962). The whole message stream is the pump's from the first frame on.
		 */
		const open = Effect.fn("TuvalAiAgent.start.open")(function* (
			cwd: string,
			resume: string | undefined,
			held: Mode | null,
		) {
			const stale: Array<string> = [];
			// The rows this read maps are the resumed session's whole stored transcript, and the core
			// re-plans its window over them (#8855). Before that they were mapped for the unsettled
			// tool ids and thrown away, which is why a checkpointed tail written under an older window
			// rule could only ever be replayed verbatim.
			let history: ReadonlyArray<TranscriptItem> | undefined;
			if (resume !== undefined) {
				const rows = yield* Effect.tryPromise({
					try: () => sdk.getSessionMessages(resume, {dir: cwd}),
					catch: (cause) => startTransport(cwd, cause),
				});
				// An empty read is not a miss: the pin answers `[]` for a session it does not hold and
				// for one that is genuinely empty alike, and `ResumeTarget` promises any listed id
				// resumes. So the store's listing settles it, and only a listing with no such row is
				// `session-not-found` (#8131).
				if (
					rows.length === 0 &&
					!(yield* storeHolds(resume, (cause) => startStoreUnreadable(cwd, cause)))
				) {
					return yield* sessionNotFound(cwd, resume);
				}
				const {items} = toHistoryItems(rows, {at: Date.now()});
				stale.push(...unsettledToolIds(items).filter((id) => !parked.has(id)));
				history = items;
			}

			// A resumed session already has the CLI's id; a fresh one is opened under an id this layer
			// mints, which is what lets `started` name a session before the first turn exists.
			const choice: SessionChoice =
				resume === undefined
					? {kind: "fresh", sessionId: (options.newSessionId ?? randomUUID)()}
					: {kind: "resume", sessionId: resume};

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
							session: choice,
							...(watch === null ? {} : {spawn: watch.spawn}),
						}),
					}),
				catch: (cause) => startTransport(cwd, cause),
			});
			const abandon = Effect.sync(() => {
				input.end();
				handle.close();
			});

			const handshake = yield* Effect.tryPromise({
				try: () => handle.initializationResult(),
				catch: (cause) => startWithoutHandshake(cwd, cause),
			}).pipe(Effect.tapError(() => abandon));

			return {
				account: accountOf(handshake),
				session: {
					id: choice.sessionId,
					cwd,
					handle,
					input,
					watch,
					state: {settled: false, closing: false},
					intro: {seen: false},
					scope: yield* Scope.make(),
				} satisfies Session,
				iterator: handle[Symbol.asyncIterator](),
				stale: stale as ReadonlyArray<string>,
				history,
			};
		});

		const start = Effect.fn("TuvalAiAgent.start")(function* (startOptions: StartOptions) {
			const previous = yield* Ref.get(session);
			// A second `start` is a reconnect, and it replaces the session whole: the previous
			// subprocess is closed, its pump ended with it, and the old queue is shut so a
			// subscription taken before this call is not resurrected.
			yield* closeCurrent;
			yield* Effect.flatMap(Ref.get(queue), Queue.shutdown);

			const out = yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>();
			yield* Ref.set(queue, out);
			yield* emit(out, [{kind: "phase", phase: "starting"}]);
			// The clear `closeCurrent` just made, said out loud on the queue a consumer is on. Without
			// it a subscription taken across the swap keeps painting the dead session's rows, and an
			// open that then fails emits `gone` with nothing to correct them (#8542). The held
			// selections ride along, so the control names the pick rather than a catalog nobody holds
			// — the founder's ruling of 2026-09-08. Only after a teardown: with no previous session
			// this layer knows no selection, and announcing `current: null` would erase the one a
			// restored window is showing.
			if (previous !== null) {
				yield* emit(out, [
					{kind: "model", current: yield* Ref.get(model), available: []},
					{kind: "thinking", current: yield* Ref.get(effort), available: []},
				]);
			}

			// The layer's own switch first, then the mode the caller says to open on. The Ref is per
			// build, so on the rebuilt layer a reconnect stands up it is null and the caller's mode is
			// the operator's — which is what carries a mode switch across a restart (#7953).
			const held = (yield* Ref.get(mode)) ?? startOptions.mode ?? null;
			// One stream carries everything (ruling 1, #7570), so a failed start owes it a terminal
			// phase: without this every subscriber sits on `starting` for the life of the layer.
			const resuming = startOptions.resume?.sessionId;
			const opened = yield* open(startOptions.cwd, resuming, held).pipe(
				Effect.tapError((_error: StartError) => emit(out, [{kind: "phase", phase: "gone"}])),
			);

			yield* Ref.set(session, opened.session);
			// Said as soon as it is known rather than behind the catalogs: unlike the model and the
			// thinking levels this costs no subprocess round-trip — the handshake `open` already
			// waited for carried it. A login that reported neither field announces nothing, so the
			// inspector's row stays absent rather than empty.
			if (opened.account !== null) {
				yield* emit(out, [{kind: "account", account: opened.account}]);
			}
			// The keys belong to a session, not to the layer: a key is dropped when this *session* has
			// seen it, so a new session admits one the previous session spent. Resuming the session the
			// keys were recorded under is the one case that keeps them.
			const continuing = previous !== null && resuming === previous.id;
			if (!continuing) yield* Ref.set(keys, new Set<string>());

			// The announced mode is resolved by the same call `open` opened the query with, never the
			// raw `held`: `held` is null until an operator calls `setMode`, so a row carrying any
			// non-default `permissionMode` would run on that mode and tell every subscriber it has
			// none — a `current: null` beside a non-empty `available` is not a state `ModePayload`
			// defines (#7828). The Ref takes it too, so a later refused `setMode` re-announces the
			// mode the session is really on rather than the null a rebuilt layer started from.
			const openedOn = openingMode(options, held) as Mode;
			yield* Ref.set(mode, openedOn);
			yield* emit(out, [{kind: "mode", current: openedOn, available}]);
			// The catalog is the session's, so it is read after the open. The announced model is the
			// one the session is actually running: the query opened on the row's static `model`, so a
			// model an operator picked before this open has to be re-applied here rather than merely
			// re-announced — the mode switch learned that in #7828.
			const rows = yield* readCatalog(opened.session);
			const offered = rows.map(refOf);
			yield* Ref.set(models, offered);
			const table = effortsOf(rows);
			yield* Ref.set(efforts, table);
			const runningId = (yield* readRunningModel(opened.session)) ?? options.model;
			// `resolvedModel` matches a canonical running id to its selectable alias (sdk.d.ts).
			// Catalog order is not evidence that a row is active, even when it is named Default.
			const runningRow =
				runningId === undefined
					? undefined
					: (rows.find((row) => row.value === runningId) ??
						rows.find((row) => row.resolvedModel === runningId));
			const spawned = runningRow === undefined ? null : refOf(runningRow);
			const picked = yield* Ref.get(pickedModel);
			const opening =
				picked === null || !offered.some((candidate) => sameModel(candidate, picked))
					? spawned
					: (yield* applyModel(opened.session, picked))
						? picked
						: spawned;
			yield* Ref.set(model, opening);
			yield* emit(out, [{kind: "model", current: opening, available: offered}]);
			const catalog = yield* readCommands(opened.session);
			yield* Ref.set(commands, catalog);
			yield* emit(out, [{kind: "commands", available: catalog}]);
			// The same re-apply the model gets one line up: a level an operator picked before this
			// open is applied to the new session rather than merely re-announced, and one the model
			// this session landed on does not offer is dropped instead of sent.
			const levels = offeredEfforts(table, opening);
			const wanted = yield* Ref.get(effort);
			// `find` rather than `includes`: the held pick is a `ThinkingLevel`, and what comes back
			// is typed by this session's own offer, so `applyEffort` cannot be reached with one of
			// the two levels Claude has no effort for.
			const supported = levels.find((candidate) => candidate === wanted);
			const running =
				supported === undefined
					? null
					: (yield* applyEffort(opened.session, supported))
						? supported
						: null;
			yield* Ref.set(effort, running);
			// The open's `ready` ships here, behind the catalogs, and never ahead of them: the
			// composer derives "the layer has said what this session offers" from the phase, so a
			// `ready` emitted before these four subprocess round-trips tells the picker the offer
			// resolved empty for as long as they take (#8425). The catalogs are the layer's own
			// narration of the open too — the core is already `ready` off the `started` this call
			// answers, and `coreOwned` drops a layer `starting` (`ai-agent/core/fold.ts`, #7948) but
			// not this. See `.patterns/agent-layer-phase-contract.md`.
			yield* emit(out, [
				{kind: "thinking", current: running, available: levels},
				{kind: "phase", phase: "ready"},
			]);
			// A card the layer does not hold cannot be answered, so a window restored with one would
			// wedge on it. Resolving it is what lets the generic restore drop it (#7608).
			yield* emit(
				out,
				opened.stale.map(
					(request) => ({kind: "permission-resolved", request, decision: "deny"}) as const,
				),
			);

			// Last, and forked into the session's own scope: the fan lives exactly as long as the
			// subprocess it reads and dies with it, and starting it after the emits above is what
			// keeps the session's own opening frames behind them on the one stream.
			yield* Effect.forkIn(
				drive(out, opened.iterator, emptyMapping, opened.session),
				opened.session.scope,
			);
			return {
				sessionId: opened.session.id,
				...(opened.history === undefined ? {} : {history: opened.history}),
			};
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
			// The turn's start, narrated on the same queue its end will be — the pair is what makes
			// a boundary, and the core accepts a send only on the end of a turn it saw begin
			// (#8107). Without it the opening `ready` this session emitted into the queue before
			// anything subscribed to it reads exactly like a turn's end.
			//
			// Before the write, not after, because the queue's order is the whole point: `drive`
			// pushes the `result` turn's `ready` from its own fiber, and a narration published
			// after the push could be offered behind it. A write that then fails is a turn nobody
			// ran, and the `PromptError` below settles that send on its own arm regardless.
			yield* publish([{kind: "phase", phase: "prompting"}]);
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
				// `interrupt` declares no error channel, so the refusal rides the stream as a tag the
				// fold routes on its own (ADR 0356). `settled` is read here rather than above because
				// the turn can end while the control request is in flight.
				Effect.catch((refusal) =>
					publish([
						{
							kind: "failure",
							failure: interruptFailureOf(refusal, !current.state.settled),
						},
					]),
				),
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
								Effect.as(logRefused("the mode switch was refused", refusal), false),
							),
						);
			if (changed) yield* Ref.set(mode, next);
			const held = yield* Ref.get(mode);
			yield* publish([{kind: "mode", current: held, available}]);
		});

		const setModel = Effect.fn("TuvalAiAgent.setModel")(function* (next: ModelRef) {
			const offered = yield* Ref.get(models);
			const current = yield* Ref.get(session);
			// With no session there is no catalog to judge against — the rows belong to a live query
			// and `closeCurrent` drops them — so the pick is taken unvalidated rather than refused
			// with the model listed against an empty `available`, the self-contradicting refusal
			// #7981 ruled out. Validation is not skipped, only deferred: `start` re-checks the held
			// pick against the catalog it reads and opens on the spawned model instead when that
			// catalog does not carry it, so `ModelUnsupported` still means "the session refuses it"
			// wherever a session exists to refuse (#8061).
			const picked =
				current === null ? next : offered.find((candidate) => sameModel(candidate, next));
			if (picked === undefined) {
				return yield* new ModelUnsupported({
					model: next.id,
					available: offered.map((candidate) => candidate.id),
				});
			}
			const changed = current === null ? true : yield* applyModel(current, picked);
			if (changed) {
				yield* Ref.set(model, picked);
				yield* Ref.set(pickedModel, picked);
			}
			const held = yield* Ref.get(model);
			yield* publish([{kind: "model", current: held, available: offered}]);
			// The offered levels are the model's, so a switch moves the picker's rows. A level the
			// new model does not offer stops being the current one rather than staying on a state it
			// would now refuse — against a live catalog only: between sessions there is none to judge
			// it by, and dropping the held level there would spend the operator's pick on a model
			// switch the next open has not seen yet (#8542).
			const table = yield* Ref.get(efforts);
			const levels = offeredEfforts(table, held);
			const running = yield* Ref.get(effort);
			const kept =
				current === null ? running : (levels.find((candidate) => candidate === running) ?? null);
			yield* Ref.set(effort, kept);
			yield* publishThinking(kept, levels);
		});

		const setThinkingLevel = Effect.fn("TuvalAiAgent.setThinkingLevel")(function* (
			next: ThinkingLevel,
		) {
			const table = yield* Ref.get(efforts);
			const levels = offeredEfforts(table, yield* Ref.get(model));
			const current = yield* Ref.get(session);
			// The session is read before the offer is judged, and that order is the whole fix: with
			// no session the table is empty, so judging first refused every pick with the level
			// listed against an empty `available` — the self-contradicting refusal #7981 ruled out,
			// and the hold the comment here used to describe was unreachable (#8542). Validation is
			// deferred, not skipped: `start` re-checks the held level against the catalog it reads
			// and drops one this session's model does not offer.
			if (current === null) {
				yield* Ref.set(effort, next);
				return yield* publishThinking(next, levels);
			}
			// `find` rather than `includes`: what comes back is typed as an `EffortLevel`, so the SDK
			// call below cannot be reached with one of the two levels Claude has no effort for.
			const picked = levels.find((candidate) => candidate === next);
			if (picked === undefined) {
				return yield* new ThinkingUnsupported({level: next, available: levels});
			}
			if (yield* applyEffort(current, picked)) yield* Ref.set(effort, picked);
			yield* publishThinking(yield* Ref.get(effort), levels);
		});

		const page = Effect.fn("TuvalAiAgent.page")(function* (before: string | null, limit: number) {
			const current = yield* Ref.get(session);
			if (current === null) return yield* noSessionToPage();
			const rows = yield* Effect.tryPromise({
				try: () => sdk.getSessionMessages(current.id, {dir: current.cwd}),
				catch: storeUnreadable,
			});
			const {items, cursorAliases} = toHistoryItems(rows, {at: Date.now()});
			const planned = planTranscriptPage(items, {
				before,
				cursorAliases,
				limit,
				cursorBoundary: "containing-group",
			});
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

		/**
		 * `page`'s answer off the store, with no session open (#8233). `getSessionMessages` reads the
		 * CLI's transcript files directly, so nothing here touches the `query()` this layer's `start`
		 * owns and the read works on a layer that never opened one.
		 */
		const sessionTranscript = Effect.fn("TuvalAiAgent.sessionTranscript")(function* (
			query: TranscriptQuery,
		) {
			const rows = yield* Effect.tryPromise({
				try: () => sdk.getSessionMessages(query.sessionId, {dir: query.cwd}),
				catch: (cause) => transcriptUnreadable(query.sessionId, cause),
			});
			// The pin answers an empty array for a session it does not hold as readily as for one
			// that is genuinely empty (`refusals.ts`), so the listing settles which of the two this
			// is rather than the caller reading silence as either.
			if (
				rows.length === 0 &&
				!(yield* storeHolds(query.sessionId, (cause) =>
					transcriptUnreadable(query.sessionId, cause),
				))
			) {
				return yield* transcriptSessionNotFound(query.sessionId);
			}
			const {items, cursorAliases} = toHistoryItems(rows, {at: Date.now()});
			const planned = planTranscriptPage(items, {
				before: query.before,
				cursorAliases,
				limit: query.limit,
				cursorBoundary: "containing-group",
			});
			if (isRefusal(planned)) {
				if (planned.reason === "limit-not-positive") {
					return yield* Effect.die(
						new Error(`page was asked for ${query.limit} items; the port declares limit > 0`),
					);
				}
				return yield* transcriptUnknownCursor(query.sessionId, planned.reason);
			}
			return {items: planned.items, hasMore: planned.next !== null};
		});

		/**
		 * One subagent this session spawned, as its own transcript and its type (#8404).
		 *
		 * `page`'s shape, on a different file: the live session names it, the store reads it, and
		 * what comes back is the port's item union plus a plain type string. Nothing Claude-shaped
		 * crosses out of here, which is what lets the subagent view render off it (#8406).
		 *
		 * Not `getSessionMessages`: at 0.3.259 it "returns Array of messages, or empty array if
		 * session not found" (`sdk.d.ts`) and guards its session id as a UUID (`sdk.mjs`), so an
		 * agent id gets the empty array rather than a refusal — see `sidechain-store.ts`.
		 */
		const subagentTranscript = Effect.fn("TuvalAiAgent.subagentTranscript")(function* (
			agentId: string,
		) {
			const current = yield* Ref.get(session);
			if (current === null) return yield* noSessionToPage();
			return yield* readSubagentTranscript({cwd: current.cwd, id: current.id}, agentId, Date.now());
		});

		/**
		 * Every Claude session on this machine, not this layer's own: the CLI's store is read off
		 * disk, so this answers before `start` and on a layer that never opens a session.
		 *
		 * Called with no options at all, which is both "sessions across all projects" (`dir` omitted)
		 * and `includeProgrammatic` left at its `true` default — epic #8070's ruling 3 wants one
		 * unified list, which is the opposite of the `/resume` parity the pin documents `false` for.
		 */
		const listSessions = Effect.tryPromise({
			try: () => sdk.listSessions(),
			catch: storeUnlistable,
		}).pipe(Effect.map(claudeSessions), Effect.withSpan("TuvalAiAgent.listSessions"));

		return {
			start,
			prompt,
			interrupt,
			answer,
			setMode,
			setModel,
			commands: Ref.get(commands),
			setThinkingLevel,
			page,
			sessionTranscript,
			subagentTranscript,
			listSessions,
			events: withTurnResult(
				Stream.unwrap(Effect.map(Ref.get(queue), (held) => Stream.fromQueue(held))),
			),
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
