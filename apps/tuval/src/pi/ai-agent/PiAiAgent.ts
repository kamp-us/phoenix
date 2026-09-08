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
import {dirname, join} from "node:path";
import {getAgentDir, ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import {type Cause, Effect, Fiber, Layer, Queue, Redacted, Ref, type Scope, Stream} from "effect";
import {isRefusal} from "../../ai-agent/history/index.ts";
import type {
	Mode,
	ModelRef,
	PermissionDecision,
	ThinkingLevel,
} from "../../ai-agent/ports/index.ts";
import {sameModel} from "../../ai-agent/ports/index.ts";
import {
	type AgentEvent,
	ListError,
	ModelUnsupported,
	ModeUnsupported,
	PageError,
	PromptError,
	type StartOptions,
	ThinkingUnsupported,
	type TranscriptQuery,
	type TransportError,
	TuvalAiAgent,
	type TuvalAiAgentApi,
	UnknownRequest,
} from "../../ai-agent/service/index.ts";
import {PiClientService, type PiSessionRef, type SessionUpdate} from "../client/index.ts";
import {
	agentSessionHostLayer,
	defaultSessionDir,
	ModelRuntimeUnavailable,
	type PiServerLimits,
	PiServerService,
	type PiSessionHost,
	type ServerBindFailed,
} from "../server/index.ts";
import {planPageOverEntries} from "./entries.ts";
import {
	deltaEventsOf,
	emptyProjection,
	eventsOf,
	paintOf,
	projectionOf,
	type SnapshotProjection,
} from "./items.ts";
import {
	interruptFailureOf,
	promptDropOf,
	promptErrorOf,
	promptFailureOf,
	startErrorOf,
	storeUnreadable,
	transcriptSessionMissing,
	transcriptUnknownCursor,
	transcriptUnreadable,
	transportErrorOf,
} from "./refusals.ts";
import {piSessionDirs, readPiSessions} from "./sessions.ts";

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
	/**
	 * Project the reply still being written, so the window shows text as the model writes it rather
	 * than when the turn ends. Absent is off, which is the shape every caller had before this key.
	 */
	readonly streamPartialText?: boolean;
}

type EventQueue = Queue.Queue<AgentEvent, TransportError | Cause.Done>;

/**
 * What one session's fold reads. `sent` is the turn's start as a fact rather than as a difference
 * between snapshots, and it is what makes the turn's *end* a difference at all: the server's push
 * for a whole turn can coalesce into a single read taken after it finished, so the projection would
 * otherwise sit at `ready` from before the send to after it and emit nothing, while the core moved
 * itself to `prompting` at the send and stayed there — refusing every later message (#7897).
 */
type FoldInput = SessionUpdate | {readonly _tag: "sent"};

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
 * Where one stored session's JSONL sits, across every directory either store keeps files in, or
 * `null` when it is in none of them. A genuine miss, told apart from a directory that would not
 * open by the `Effect.try` around the scan (#8233).
 */
const locateBranch = (dirs: ReadonlyArray<string>, sessionId: string) =>
	Effect.try({
		try: (): string | null => {
			for (const dir of dirs) {
				const file = readdirSync(dir).find((name) => name.endsWith(`_${sessionId}.jsonl`));
				if (file !== undefined) return join(dir, file);
			}
			return null;
		},
		catch: (cause) => transcriptUnreadable(sessionId, cause),
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
		const agentDir = options.agentDir ?? getAgentDir();

		const session = yield* Ref.make<PiSessionRef | null>(null);
		// The pick an operator made before a session existed. It survives to the next `start`,
		// which opens on it — the shape `ClaudeAiAgent` holds one across a respawn.
		const pendingModel = yield* Ref.make<ModelSelection | null>(null);
		const pendingThinking = yield* Ref.make<ThinkingLevel | null>(null);
		const keys = yield* Ref.make<ReadonlySet<string>>(new Set());
		const dialled = yield* Ref.make(false);
		const pump = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);
		const inbox = yield* Ref.make<Queue.Queue<FoldInput> | null>(null);
		// Held out here rather than inside `follow` because `interrupt` reads it too: whether the
		// session is still on a turn is the half a refused abort's tag has to carry (ADR 0356), and
		// Pi's own refusal says nothing about it.
		const projection = yield* Ref.make<SnapshotProjection>(emptyProjection);

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
		 *
		 * Everything the projection folds arrives through `feed`, including the server's own
		 * pushes: one queue is what keeps a `sent` mark and a snapshot in the order they happened,
		 * and one consumer is what keeps two arrivals from interleaving a revision.
		 */
		const follow = (
			sessionId: string,
			open: EventQueue,
			feed: Queue.Queue<FoldInput>,
			seed: SnapshotProjection,
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				yield* Ref.set(projection, seed);
				const pushes = pi
					.updates(sessionId)
					.pipe(Stream.runForEach((update) => Queue.offer(feed, update)));
				const folding = Stream.fromQueue(feed).pipe(
					Stream.runForEach((input) =>
						Effect.gen(function* () {
							const previous = yield* Ref.get(projection);
							if (input._tag === "sent") {
								if (previous.phase === "prompting") return;
								yield* Ref.set(projection, {...previous, phase: "prompting"});
								return yield* emit(open, [{kind: "phase", phase: "prompting"}]);
							}
							const folded =
								input._tag === "snapshot"
									? eventsOf(previous, input.snapshot)
									: deltaEventsOf(previous, input.delta);
							yield* Ref.set(projection, folded.next);
							yield* emit(open, folded.events);
						}),
					),
				);
				const dropped = pi.disconnections.pipe(
					Stream.take(1),
					Stream.runForEach((drop) => Queue.fail(open, transportErrorOf(drop))),
				);
				// `pushes` only fills `feed`, so it is not a party to the race: raced against
				// `folding` it would interrupt the fold the moment the update stream ended, and a
				// turn's last update — queued, unfolded — would go with it (#8554). As a child
				// fiber it is interrupted when this effect returns, which is what the race decides.
				yield* Effect.forkChild(pushes);
				yield* Effect.race(folding, dropped);
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

		const start = Effect.fn("TuvalAiAgent.start")(function* (options_: StartOptions) {
			const previous = yield* Ref.get(pump);
			if (previous !== null) yield* Fiber.interrupt(previous);
			yield* Effect.flatMap(Ref.get(queue), Queue.shutdown);
			const stale = yield* Ref.get(inbox);
			if (stale !== null) yield* Queue.shutdown(stale);

			const open = yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>();
			yield* Ref.set(queue, open);
			yield* emit(open, [{kind: "phase", phase: "starting"}]);

			const acquire = Effect.gen(function* () {
				yield* dial;
				// A held pick outranks the layer's static option: it is the later choice, and this
				// open is the one it was made for.
				const opening = (yield* Ref.get(pendingModel)) ?? options.model;
				const resume = options_.resume;
				if (resume === undefined) {
					const opened = yield* pi.createSession(
						options_.cwd,
						opening === undefined ? {} : {model: opening},
					);
					return {ref: opened, seed: emptyProjection, paint: []};
				}
				// Either way the lease's own snapshot is the seed, and neither reading of it costs a
				// round trip. What differs is what the caller can already see.
				const resumed = yield* pi.attachSession(resume.sessionId);
				const lease = yield* pi.heldSnapshot(resumed.id);
				// A restored process is looking at its own committed tail, so the seed suppresses
				// everything through the boundary that tail reaches and emits whatever the session
				// finished past it — or changed under it — while the socket was down (#8374).
				const seeded = resume.holdsTranscript ? projectionOf(lease, resume.held) : null;
				if (seeded !== null) return {ref: resumed, seed: seeded, paint: []};
				// Nothing to seed from: a window opened out of the picker holds nothing, or the
				// boundary the caller holds is not in this snapshot. Either way the history is
				// painted here, at the attach, while its tail is still empty — a push carries only
				// what changed, so waiting for one would replay nothing (#8554).
				const painted = paintOf(lease);
				return {ref: resumed, seed: painted.projection, paint: painted.events};
			}).pipe(Effect.mapError((refusal) => startErrorOf(options_.cwd, refusal)));

			// One stream carries everything (ruling 1, #7570), so a failed start owes it a terminal
			// phase: without this every subscriber sits on `starting` for the life of the layer.
			const {ref, seed, paint} = yield* acquire.pipe(
				Effect.tapError(() => emit(open, [{kind: "phase", phase: "gone"}])),
			);
			yield* emit(open, paint);

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
			const feed = yield* Queue.unbounded<FoldInput>();
			yield* Ref.set(inbox, feed);
			// Forked into the layer's own scope, not the caller's, so the fan lives exactly as long
			// as the transport it reads and dies with it.
			yield* Ref.set(pump, yield* Effect.forkIn(follow(ref.id, open, feed, seed), scope));
			const offered = catalog.map(refOf);
			yield* emit(open, [
				// `StartOptions.mode` is ignored here, and this is the one layer where that is right:
				// Pi offers no modes at this pin, so there is no operator switch for a rebuilt layer to
				// lose and the checkpoint carries the same `null` back (#7953).
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
			// Read here rather than inside the fork, so a `start` that lands while this send is in
			// flight cannot route the old session's turn into the new session's fold.
			const feed = yield* Ref.get(inbox);
			// The turn has begun, and this is the only unlosable statement of that: see `FoldInput`.
			if (feed !== null) yield* Queue.offer(feed, {_tag: "sent"});
			// The pin answers a `prompt` request with the snapshot the turn ended on, so awaiting it
			// here would return at the end of the turn rather than at the send — and the generic
			// host awaits a Cmd handler before it publishes the commit that handler came from, so
			// the operator's own message would not paint until the reply landed (#8018). Forked into
			// the layer's scope, this returns at the send, as the Claude layer's does.
			//
			// That answer is the turn's end, and it goes into the same fold rather than being
			// dropped: the push carrying it can be coalesced away, and then nothing else ever says
			// the turn finished. Re-folding a snapshot the pushes already delivered emits nothing,
			// because the projection emits only a difference.
			yield* Effect.forkIn(
				pi.prompt(current.id, text).pipe(
					Effect.mapError(promptErrorOf),
					// A send that never landed is not a turn this session has seen, so the key goes
					// back and a retry of it is admitted.
					Effect.tapError(() => (key === undefined ? Effect.void : Ref.update(keys, without(key)))),
					Effect.tap((snapshot) =>
						feed === null ? Effect.void : Queue.offer(feed, {_tag: "snapshot", snapshot}),
					),
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
				// `interrupt` declares no error channel, so the refusal rides the stream as a tag the
				// fold routes on its own (ADR 0356) — a log line left the window unable to tell a
				// backend that said no from an abort still in flight.
				Effect.catch((refusal) =>
					Effect.gen(function* () {
						const running = (yield* Ref.get(projection)).phase === "prompting";
						const open = yield* Ref.get(queue);
						yield* emit(open, [{kind: "failure", failure: interruptFailureOf(refusal, running)}]);
					}),
				),
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
			const planned = planPageOverEntries(entries, {before, limit});
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

		/**
		 * `page`'s answer off disk, with no session open and no transport dialled (#8233).
		 *
		 * It walks both stores rather than `sessionDir(cwd)` alone, because the ids it is handed come
		 * off `listSessions` below, which unions the two — a session the operator started with `pi`
		 * in a terminal is in the CLI store and would otherwise read as gone.
		 *
		 * Nothing here reaches `paintOf`: that fold builds a whole transcript's worth of `item` and
		 * `usage` events for the attach to emit, and on this path there is no attach and no
		 * subscriber, so the events would be built and dropped.
		 */
		const sessionTranscript = Effect.fn("TuvalAiAgent.sessionTranscript")(function* (
			query: TranscriptQuery,
		) {
			const stores = yield* piSessionDirs({agentDir, tuvalDir: sessionDir(query.cwd)});
			const file = yield* locateBranch(stores.dirs, query.sessionId);
			if (file === null) {
				// A store that would not enumerate may be the one the file was in, so a miss across the
				// rest is not the claim that the session is gone.
				return yield* stores.failures.length === 0
					? transcriptSessionMissing(query.sessionId)
					: transcriptUnreadable(
							query.sessionId,
							stores.failures.map((failure) => `${failure.store}: ${failure.detail}`).join("; "),
						);
			}
			const entries = yield* Effect.try({
				try: () => SessionManager.open(file, dirname(file), query.cwd).getBranch(),
				catch: (cause) => transcriptUnreadable(query.sessionId, cause),
			});
			const planned = planPageOverEntries(entries, {
				before: query.before,
				limit: query.limit,
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
		 * Both of Pi's stores, unioned (#8099). A read of disk rather than of the transport, so it
		 * answers before `start` and after a drop.
		 *
		 * Tuval's own store is located under the project root the layer was built on, or under the
		 * running session's cwd when the layer was given none — the same one root `start({resume})`
		 * looks in. With neither, only the `pi` CLI's store is reachable and the answer says so by
		 * holding its rows alone.
		 *
		 * A failed store is a log line and not the answer: it fails only when no store answered at
		 * all, because returning `[]` there would claim this machine holds no Pi sessions.
		 */
		const listSessions = Effect.gen(function* () {
			const current = yield* Ref.get(session);
			const root = options.projectRoot ?? current?.cwd;
			const read = yield* readPiSessions({
				agentDir,
				...(root === undefined ? {} : {tuvalDir: sessionDir(root)}),
			});
			yield* Effect.forEach(
				read.failures,
				(failure) =>
					Effect.logWarning(
						`the ${failure.store} Pi session store could not be read: ${failure.detail}`,
					),
				{concurrency: 1, discard: true},
			);
			if (read.answered.length === 0) {
				return yield* new ListError({
					reason: "store-unreadable",
					detail: read.failures.map((failure) => `${failure.store}: ${failure.detail}`).join("; "),
				});
			}
			return read.sessions;
		}).pipe(Effect.withSpan("TuvalAiAgent.listSessions"));

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
			/**
			 * Empty by ruling, not by omission (founder, 2026-09-05, #8060). Pi's slash commands live
			 * inside its `AgentSession` — extension commands, skills, prompt templates — and the wire
			 * Tuval reaches it over carries no list of them: Tuval's own `ServerSnapshot` is
			 * `{serverId, protocolVersion, revision, sessions, models}` and its `Command` is a closed
			 * nine-verb union. Filling this needs Pi to expose the catalog through `AgentSession`,
			 * which is its own ticket; vendoring or forking that dep is a no-go.
			 *
			 * Only the *catalog* is missing. Running one already works: `expandPromptTemplates`
			 * (default true, `agent-session.d.ts`) dispatches extension commands and expands skill
			 * commands on the prompt text itself, so a `/skill:foo` the operator types lands.
			 */
			commands: Effect.succeed([]),
			setThinkingLevel,
			page,
			sessionTranscript,
			listSessions,
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
			return PiClientService.layerWebSocket({
				url: Redacted.value(running.url),
				serverId: running.serverId,
			});
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
				...(options.streamPartialText === undefined
					? {}
					: {streamPartialText: options.streamPartialText}),
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
