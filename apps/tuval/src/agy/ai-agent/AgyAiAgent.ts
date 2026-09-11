/**
 * `AgyAiAgent` — the `TuvalAiAgent` layer over the `agy` CLI. **A subprocess with a pipe**, and
 * deliberately none of Pi's `client/` + `server/` loopback RPC: this row follows `src/pi/`'s shape
 * and not `src/claude/`'s, so there is no `tools/`, no `KernelBridge`, no `SpellBridge`, no `scope`
 * option and no permission card anywhere under `src/agy/` (#8162).
 *
 * The layer is the transport's lifetime (founder ruling 4, #7570). `R` is empty and `E` is `never`:
 * a process hands `AgyAiAgent.layer(options)` to `aiAgentProgram` and holds no agy value of its
 * own. `start` is the handler's call, not the layer's, so restore is "rebuild the layer, then
 * `start({cwd, resume: conversationId})`".
 *
 * **Three of the eleven members are respawns, because agy has no mid-session switch.** It refuses one
 * verbatim — `/model is answered by the CLI itself and is unavailable with --input-format
 * stream-json; run it as its own --print invocation` — and `/effort` behaves the same. So
 * `setModel`, `setMode` and `setThinkingLevel` each take the child down and launch a new one with
 * `--conversation=<id>`, which returns the same conversation id and carries its context. The event
 * queue is *not* replaced across a respawn: a model switch must not end the window's subscription.
 *
 * **`interrupt` ends the child, and then relaunches it.** SIGINT makes agy exit 1 after a
 * well-formed terminal `result` reading `status: "ERROR"` / `error: "interrupted"` — measured at
 * v1.1.27 and v1.1.28, correcting ADR 0362's original reading of that string as
 * `"timeout waiting for response"` (#8694). So the stop is named on the stream and `mapper.ts` marks
 * the cut reply off it; the layer's own memory of *which child* it signalled is still what
 * `refusals.ts`'s `processGone` spends, because a child that dies with no terminal result at all says
 * nothing either way. That memory is also what keeps the exit watch off the event queue for a stop,
 * because the fourth respawn is this one: `interrupt` relaunches on the same conversation id the way
 * the three switches do, so a stop lands the window back on `ready` with a live child instead of on a
 * session nothing but a fresh window could replace (#8709). The `ready` that stop ends on is
 * published off the terminal `result`, which is *before* the relaunch finishes — so the relaunch is
 * also the one span in which `prompt` refuses: see `relaunchOver`.
 *
 * **Two agy behaviours shape this file without being visible in it.** Turns are strictly sequential
 * — stdin lines queue and a second prompt does not preempt a running one — so nothing here
 * serialises sends, because the CLI already does. And the first write to a new path is denied and
 * succeeds on retry as the Seatbelt profile widens; that costs a turn and reads to a model as a
 * settled refusal, which is why `AGY_RETRY_HINT` opens every session as a system row rather than
 * being left to look like a bug.
 */

import {homedir} from "node:os";
import {NodeChildProcessSpawner, NodeFileSystem, NodePath} from "@effect/platform-node";
import {
	type Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Queue,
	Ref,
	Scope,
	Stream,
} from "effect";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {isRefusal} from "../../ai-agent/history/index.ts";
import {
	type CommandRef,
	Mode,
	type ModelRef,
	type PermissionDecision,
	sameModel,
	type ThinkingLevel,
} from "../../ai-agent/ports/index.ts";
import {
	type AgentEvent,
	ListError,
	ModelUnsupported,
	ModeUnsupported,
	type ResumeTarget,
	type StartError,
	ThinkingUnsupported,
	type TranscriptQuery,
	type TransportError,
	TuvalAiAgent,
	type TuvalAiAgentApi,
	UnknownRequest,
} from "../../ai-agent/service/index.ts";
import {withTurnResult} from "../../ai-agent/turn-result.ts";
import {
	AGY_BINARY,
	AGY_EFFORTS,
	AGY_MODELS,
	AGY_MODES,
	type AgyAiAgentOptions,
	type AgyMode,
} from "../config.ts";
import {commandsOf} from "./commands.ts";
import {systemItem} from "./items.ts";
import {commandArgv, promptLine, sessionArgv} from "./launch.ts";
import {type AgyTurn, eventsOf, idleTurn} from "./mapper.ts";
import {
	detailOf,
	historyUnreadable,
	interruptFailureOf,
	malformedPrompt,
	noSession,
	processGone,
	relaunchInFlight,
	resumeFailed,
	startFailed,
	transcriptSessionMissing,
	transcriptUnknownCursor,
	transcriptUnreadable,
	unknownCursor,
} from "./refusals.ts";
import {makeStopClaim} from "./stop-claim.ts";
import {conversationDir, readTranscriptPage} from "./transcript.ts";
import {decodeLine} from "./wire.ts";

/**
 * The one thing this layer tells the model that agy does not: a denied first write is not a
 * refusal. It opens every session as a system row, because the alternative is a model that reads
 * the Seatbelt profile's first denial as settled and abandons the edit (ADR 0362).
 */
export const AGY_RETRY_HINT =
	"agy note: the sandbox profile widens as it runs, so the first write to a path it has not seen is denied and the same write succeeds on a retry. One denial is not a settled refusal — retry once before changing approach.";

/** How long a launch may take to say `init` before it is called a failed start rather than a slow one. */
const START_TIMEOUT = "60 seconds";

type EventQueue = Queue.Queue<AgentEvent, TransportError | Cause.Done>;

/** One launched `agy`, and everything needed to feed it, read it, and take it down again. */
interface Child {
	readonly handle: ChildProcessSpawner.ChildProcessHandle;
	/** Every turn is one line offered here; the spawner runs this queue into the child's stdin. */
	readonly stdin: Queue.Queue<Uint8Array>;
	readonly scope: Scope.Closeable;
	readonly fiber: Fiber.Fiber<void>;
}

/** One open conversation, in the vocabulary the launch speaks rather than the port's. */
interface Session {
	readonly conversationId: string;
	readonly cwd: string;
	readonly model: string | null;
	readonly mode: AgyMode | null;
	readonly effort: ThinkingLevel | null;
	readonly child: Child;
}

/** What the next launch carries, held whether or not a session exists to carry it yet. */
interface Settings {
	readonly model: string | null;
	readonly mode: AgyMode | null;
	readonly effort: ThinkingLevel | null;
}

const isAgyMode = (value: string): value is AgyMode =>
	(AGY_MODES as ReadonlyArray<string>).includes(value);

const isAgyEffort = (level: ThinkingLevel): boolean =>
	(AGY_EFFORTS as ReadonlyArray<ThinkingLevel>).includes(level);

const advertisedModes: ReadonlyArray<Mode> = AGY_MODES.map((mode) => Mode.make(mode));

/** The catalog row a model id names, or a ref labelled by that id when the catalog does not list it. */
const refOf = (offered: ReadonlyArray<ModelRef>, id: string | null): ModelRef | null =>
	id === null ? null : (offered.find((candidate) => candidate.id === id) ?? {id, name: id});

const encoder = new TextEncoder();

type Requirements = Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem;

const make = (options: AgyAiAgentOptions): Effect.Effect<TuvalAiAgentApi, never, Requirements> =>
	Effect.gen(function* () {
		// Captured once and provided into each body, so every member below carries `R = never`
		// (`.patterns/effect-process-cli-shell.md`).
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const filesystem = yield* FileSystem.FileSystem;
		const layerScope = yield* Effect.scope;

		const binary = options.binary ?? AGY_BINARY;
		const home = options.home ?? homedir();
		const offered = options.models ?? AGY_MODELS;
		const envOptions =
			options.env === undefined ? {} : {env: {...options.env}, extendEnv: true as const};

		const session = yield* Ref.make<Session | null>(null);
		const keys = yield* Ref.make<ReadonlySet<string>>(new Set());
		const commandCache = yield* Ref.make<ReadonlyArray<CommandRef>>([]);
		// The child a stop was delivered to, which is the stop itself — see `stop-claim.ts` for why
		// the memory is a domain object rather than a `Ref` this scope can read and write.
		const stop = yield* makeStopClaim;
		// Set from the delivered signal through to the session the relaunch reopened: the span in
		// which `session` still holds a torn-down child. `prompt` refuses across it — see there.
		const relaunching = yield* Ref.make(false);
		// Whether a turn is in flight: true from the send, false once the envelope says `result`.
		// It is the reason a refused interrupt carries (ADR 0356), and nothing on agy's wire answers
		// that question — a layer that read it off the stream would have to wait for the very
		// terminal event the refusal means never comes.
		const turnLive = yield* Ref.make(false);
		/**
		 * A pick made before any session existed, or the settings the running one was launched with.
		 * Held rather than refused — "no session yet" is not "not offered" (#7981) — and on this
		 * backend it is also what a respawn is composed from.
		 */
		const settings = yield* Ref.make<Settings>({
			model: options.model ?? null,
			mode: options.mode ?? null,
			effort: options.effort ?? null,
		});

		const queue = yield* Effect.acquireRelease(
			Ref.make<EventQueue>(yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>()),
			(held) => Effect.flatMap(Ref.get(held), Queue.shutdown),
		);

		const emit = (into: EventQueue, events: ReadonlyArray<AgentEvent>): Effect.Effect<void> =>
			// Serial: one subscription, one ordering — a parallel offer would shuffle a revision.
			Effect.forEach(events, (event) => Queue.offer(into, event), {concurrency: 1, discard: true});

		const publish = (events: ReadonlyArray<AgentEvent>): Effect.Effect<void> =>
			Effect.flatMap(Ref.get(queue), (held) => emit(held, events));

		const withSpawner = <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		): Effect.Effect<A, E, Exclude<R, ChildProcessSpawner.ChildProcessSpawner>> =>
			Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);

		/**
		 * One `--print` invocation, run to completion and read whole — its own child, never a line on
		 * the running session's stdin, which agy would refuse outright. `null` is "it would not say",
		 * whether the spawn faulted or the process exited non-zero; both leave the caller's last good
		 * answer standing rather than replacing it with an emptier one.
		 */
		const runOneShot = (argv: ReadonlyArray<string>): Effect.Effect<string | null> =>
			Effect.gen(function* () {
				const handle = yield* ChildProcess.make(binary, [...argv], envOptions);
				const [stdout, exitCode] = yield* Effect.all(
					[Stream.decodeText(handle.stdout).pipe(Stream.mkString), handle.exitCode],
					{concurrency: "unbounded"},
				);
				return exitCode === 0 ? stdout : null;
			}).pipe(
				Effect.scoped,
				withSpawner,
				Effect.catchCause((cause) =>
					Effect.as(
						Effect.logWarning(`an agy ${argv.join(" ")} invocation failed: ${detailOf(cause)}`),
						null,
					),
				),
			);

		/**
		 * Everything one child says, folded once.
		 *
		 * The stdout drain, the stderr drain and the exit watch race: whichever finishes first ends
		 * the fan, and the exit is the one that fails the queue — a subprocess that went on its own is
		 * a transport that is gone, and the way back in is another `start`. An exit this layer asked
		 * for is the exception, and `interrupt` owns it.
		 *
		 * Each line is read twice, on purpose. `eventsOf` is #8178's mapper and owns the whole
		 * projection onto `AgentEvent`; `decodeLine` is consulted here for the *envelope* only,
		 * because the two facts that are not transcript content at all — which conversation this is,
		 * and that a turn ended — are carried nowhere else. It is an observation through the same
		 * reader, not a second projection.
		 */
		const follow = (
			child: {
				readonly handle: ChildProcessSpawner.ChildProcessHandle;
			},
			into: EventQueue,
			opened: Deferred.Deferred<string, string>,
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				const turn = yield* Ref.make<AgyTurn>(idleTurn);
				const lines = Stream.decodeText(child.handle.stdout).pipe(
					Stream.splitLines,
					Stream.runForEach((line) =>
						Effect.gen(function* () {
							const read = decodeLine(line);
							if (read.kind === "event" && read.event.event === "init") {
								yield* Deferred.succeed(opened, read.event.conversation_id);
							}
							const folded = eventsOf(yield* Ref.get(turn), line, Date.now());
							yield* Ref.set(turn, folded.next);
							yield* emit(into, folded.events);
							// The turn is over and the composer has to be let go of. The mapper says
							// what happened in it; only the envelope says that it ended.
							if (read.kind === "event" && read.event.event === "result") {
								yield* Ref.set(turnLive, false);
								yield* emit(into, [{kind: "phase", phase: "ready"}]);
							}
						}),
					),
					Effect.ignore,
				);
				// agy's warnings land here — `ignoring unsupported stream input message event` is the
				// one this layer's own input guard exists to make impossible. Logged rather than
				// rendered: it is diagnostic about the driver, not content the operator asked for.
				const warnings = Stream.decodeText(child.handle.stderr).pipe(
					Stream.splitLines,
					Stream.runForEach((line) =>
						line.trim().length === 0 ? Effect.void : Effect.logWarning(`agy: ${line}`),
					),
					Effect.ignore,
				);
				const ended = Effect.gen(function* () {
					const code = yield* child.handle.exitCode.pipe(Effect.orElseSucceed(() => null));
					yield* Ref.set(turnLive, false);
					const stopped = yield* stop.heldBy(child.handle);
					const failure = processGone(code, stopped);
					// A child that died before it ever said `init` is a start that failed, and its
					// caller is still holding that await.
					yield* Deferred.fail(opened, failure.detail);
					// A stop's exit is this layer's own doing and `interrupt` relaunches on the same
					// conversation, so the queue outlives it: failing it here would end the window's
					// subscription the relaunch exists to keep (#8709).
					if (stopped) return;
					yield* emit(into, [{kind: "phase", phase: "gone"}]);
					yield* Queue.fail(into, failure);
				});
				// Drains first, exit last, and never a race between them: stdout closes the instant the
				// child goes, so racing the two let the EOF cancel the exit watch — no `gone` phase,
				// no failed queue, and a window left on whatever phase it had last been given. That is
				// how an interrupted turn came to read "Ready." over a dead subprocess (#8693). In the
				// other direction the same order is what keeps the terminal `result` from being cut
				// off mid-fold by an exit that arrived while lines were still buffered.
				yield* Effect.andThen(
					Effect.all([lines, warnings], {concurrency: "unbounded", discard: true}),
					ended,
				);
			});

		/**
		 * Run one relaunch's span with `relaunching` set, given back on every exit — a failure and an
		 * interruption included, which is what keeps a failed relaunch from locking sends out for the
		 * life of the layer.
		 */
		const whileRelaunching = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
			Ref.set(relaunching, true).pipe(
				Effect.andThen(effect),
				Effect.ensuring(Ref.set(relaunching, false)),
			);

		const teardown = (child: Child): Effect.Effect<void> =>
			Fiber.interrupt(child.fiber).pipe(
				Effect.andThen(Queue.shutdown(child.stdin)),
				Effect.andThen(Scope.close(child.scope, Exit.void)),
			);

		// The child is spawned into a Scope of its own so a respawn can take one down without taking
		// the layer with it — which leaves nothing holding the last one when the layer itself closes,
		// and the CLI outlived the desk that launched it (#8696). `ChildProcess.make`'s own kill is
		// that Scope's finalizer, so closing it here is the whole fix; the codex transport gets this
		// for free by spawning into its caller's ambient Scope (`codex/transport.ts`).
		yield* Scope.addFinalizer(
			layerScope,
			Effect.flatMap(Ref.get(session), (current) =>
				current === null ? Effect.void : teardown(current.child),
			),
		);

		/**
		 * Launch, wait for `init`, and hand back the session it opened.
		 *
		 * Shared by `start` and by the three respawning switches, which differ only in whether the
		 * event queue is replaced — a fresh `start` replaces it; a switch must not, or the window's
		 * subscription would die with the model it was watching.
		 */
		const openSession = (
			next: Settings,
			cwd: string,
			resume: string | undefined,
		): Effect.Effect<Session, StartError> =>
			Effect.gen(function* () {
				const argv = sessionArgv({
					cwd,
					...(resume === undefined ? {} : {resume}),
					...(next.model === null ? {} : {model: next.model}),
					...(next.mode === null ? {} : {mode: next.mode}),
					...(next.effort === null ? {} : {effort: next.effort}),
				});
				const scope = yield* Scope.make();
				const stdin = yield* Queue.unbounded<Uint8Array>();
				const opened = yield* Deferred.make<string, string>();
				const into = yield* Ref.get(queue);
				const handle = yield* ChildProcess.make(binary, [...argv], {
					stdin: {stream: Stream.fromQueue(stdin), endOnDone: false},
					stdout: "pipe",
					stderr: "pipe",
					...envOptions,
				}).pipe(
					Effect.provideService(Scope.Scope, scope),
					withSpawner,
					Effect.tapError(() => Scope.close(scope, Exit.void)),
					Effect.mapError((cause) => detailOf(cause)),
				);
				// Forked into the *layer's* scope rather than a caller's, so the fan lives exactly as
				// long as the transport it reads and dies with the layer rather than with one call.
				const fiber = yield* Effect.forkIn(follow({handle}, into, opened), layerScope);
				const child: Child = {handle, stdin, scope, fiber};
				const conversationId = yield* Deferred.await(opened).pipe(
					Effect.timeoutOrElse({
						duration: START_TIMEOUT,
						orElse: () =>
							Effect.fail(`agy produced no init line within ${START_TIMEOUT} of launch`),
					}),
					Effect.tapError(() => teardown(child)),
				);
				return {
					conversationId,
					cwd,
					model: next.model,
					mode: next.mode,
					effort: next.effort,
					child,
				};
			}).pipe(
				Effect.tap(() => Ref.set(turnLive, false)),
				Effect.mapError((detail) =>
					resume === undefined ? startFailed(cwd, detail) : resumeFailed(cwd, resume, detail),
				),
			);

		/** The three catalogs plus the phase, in the order a window folds them. */
		const announce = (next: Session): Effect.Effect<void> =>
			publish([
				{
					kind: "mode",
					current: next.mode === null ? null : Mode.make(next.mode),
					available: advertisedModes,
				},
				{kind: "model", current: refOf(offered, next.model), available: offered},
				{kind: "thinking", current: next.effort, available: AGY_EFFORTS},
				{kind: "phase", phase: "ready"},
			]);

		/**
		 * The teardown-to-reopened-session span, which is the span no send may cross: between
		 * the two, `session` holds a child whose stdin is shut down, and `Queue.offer` on a queue that
		 * is not `Open` answers `false` rather than failing (`effect`'s `Queue.ts`) — so a send
		 * admitted here would be dropped, with its idempotency key already burned and nothing left to
		 * settle it (#8709).
		 */
		const relaunchOver = (current: Session, next: Settings): Effect.Effect<Session | null> =>
			Effect.gen(function* () {
				yield* teardown(current.child);
				const reopened = yield* openSession(next, current.cwd, current.conversationId).pipe(
					Effect.tapError((failure) =>
						Effect.gen(function* () {
							yield* Ref.set(session, null);
							// The switch's error channel is `ModelUnsupported` / `ModeUnsupported` /
							// `ThinkingUnsupported`, and a relaunch that failed is none of those: the
							// setting was offered and accepted, and it is the transport that went. So
							// it rides the stream as a failure event, which is where a caller that has
							// already been answered can still be told (#8018).
							yield* publish([
								{
									kind: "failure",
									failure: {tag: failure._tag, reason: failure.reason, detail: failure.message},
								},
								{kind: "phase", phase: "gone"},
							]);
						}),
					),
					Effect.orElseSucceed(() => null),
				);
				if (reopened === null) return null;
				yield* Ref.set(session, reopened);
				return reopened;
			});

		/**
		 * A switch agy can only answer by being relaunched. The conversation id carries, so this is a
		 * restart under the hood rather than a lost session — but it is a restart, so any turn still
		 * running goes with it, exactly as agy's own refusal implies.
		 */
		const respawn = (next: Settings): Effect.Effect<void> =>
			Effect.gen(function* () {
				const current = yield* Ref.get(session);
				yield* Ref.set(settings, next);
				if (current === null) return;
				const reopened = yield* whileRelaunching(relaunchOver(current, next));
				if (reopened === null) return;
				// Announced outside the guard, because `announce` ends on `ready` and a window that
				// answers that phase with a send must not meet the refusal the guard exists to raise.
				yield* announce(reopened);
			});

		/**
		 * `resume.holdsTranscript` is read for nothing here, and that is honest rather than an
		 * omission: a resumed agy session replays no transcript at all — the CLI reopens the
		 * conversation by id and this layer emits only the retry hint — so there is no replay for a
		 * caller's held tail to suppress.
		 */
		const start = Effect.fn("TuvalAiAgent.start")(function* (options_: {
			readonly cwd: string;
			readonly resume?: ResumeTarget;
		}) {
			const previous = yield* Ref.get(session);
			if (previous !== null) yield* teardown(previous.child);
			yield* Ref.set(session, null);
			yield* Effect.flatMap(Ref.get(queue), Queue.shutdown);

			const into = yield* Queue.unbounded<AgentEvent, TransportError | Cause.Done>();
			yield* Ref.set(queue, into);
			yield* emit(into, [{kind: "phase", phase: "starting"}]);

			const next = yield* Ref.get(settings);
			const opened = yield* openSession(next, options_.cwd, options_.resume?.sessionId).pipe(
				// One stream carries everything (ruling 1, #7570), so a failed start owes it a
				// terminal phase: without this every subscriber sits on `starting` for the life of
				// the layer.
				Effect.tapError(() => emit(into, [{kind: "phase", phase: "gone"}])),
			);
			yield* Ref.set(session, opened);
			yield* emit(into, [
				{
					kind: "item",
					item: systemItem(`${opened.conversationId}:retry-hint`, Date.now(), AGY_RETRY_HINT),
				},
			]);
			yield* announce(opened);
			return {sessionId: opened.conversationId};
		});

		const prompt = Effect.fn("TuvalAiAgent.prompt")(function* (text: string, key?: string) {
			const current = yield* Ref.get(session);
			if (current === null) return yield* noSession();
			// `ready` is published off the terminal `result`, which lands *before* the stop's relaunch
			// is finished — so a send can arrive while `session` still holds the torn-down child, and
			// the offer below would answer `false` on its shut-down stdin and settle nowhere. Refused
			// here instead, which is the one answer that renders as text the operator still has
			// (#8709).
			if (yield* Ref.get(relaunching)) return yield* relaunchInFlight();
			const composed = promptLine(text);
			// Refused *before* stdin, and that ordering is the point: a malformed `user` message is
			// fatal to the whole run rather than skipped, so a line this layer is not sure of is a
			// line it does not write.
			if (composed.kind === "refused") return yield* malformedPrompt(composed.detail);
			if (key !== undefined) {
				if ((yield* Ref.get(keys)).has(key)) return;
				// Recorded at the send, not at the turn's end: the transport-level retry the key
				// exists for fires while the first send is still in flight (ruling 2, #7570).
				yield* Ref.update(keys, (seen) => new Set(seen).add(key));
			}
			yield* Ref.set(turnLive, true);
			yield* publish([{kind: "phase", phase: "prompting"}]);
			// This is the send, and this member returns here (#8018). The reply, its tools and its
			// terminal `result` all arrive on `events` through `follow`, because the generic host
			// awaits a Cmd handler before publishing the commit that handler came from — a layer that
			// resolved this at turn-end would hold the operator's own message off the window until
			// the reply landed.
			yield* Queue.offer(current.child.stdin, encoder.encode(composed.line));
		});

		/**
		 * Stop the running turn, and come back on the same conversation.
		 *
		 * SIGINT makes agy exit, so there is no stop this child survives — which leaves the relaunch
		 * `respawn` already is as the way back, and that is what makes a stop end on `ready` with a
		 * live child rather than on a session the operator can only replace (#8709).
		 *
		 * The fan is awaited between the signal and the relaunch. `kill` resolves on the exit it
		 * asked for (`@effect/platform-node-shared`'s `NodeChildProcessSpawner`), and the fold runs a
		 * fiber behind it: the terminal `result` is what marks the cut reply `interrupted`, so a
		 * relaunch that announced the session back first would put `ready` ahead of the mark the
		 * window renders the cut turn from.
		 */
		const interrupt = Effect.gen(function* () {
			const current = yield* Ref.get(session);
			if (current === null) return;
			// A stop already in flight has nothing for a second press to send, and a second press must
			// not be able to take the first one's claim back: an exit read as one nobody asked for
			// fails the very queue the relaunch is keeping (#8883).
			if (!(yield* stop.claim(current.child.handle))) return;
			// The guard covers `kill`'s own await, not just what follows it: `kill` resolves on the
			// exit it asked for, and the cut turn's terminal `result` publishes `ready` ahead of that
			// exit — so a guard armed after the call leaves a slice where the window is free to send
			// and `session` still holds the child on its way out (#8925, #8709).
			const refused = yield* whileRelaunching(
				Effect.gen(function* () {
					const refusal = yield* current.child.handle.kill({killSignal: "SIGINT"}).pipe(
						Effect.as(null),
						// `interrupt` declares no error channel, so the refusal rides the stream as a tag
						// the fold routes on its own (ADR 0356) — a log line left the window unable to
						// tell a backend that said no from a stop still in flight. The memory of the
						// signal goes back with it: one that was never delivered must not speak for
						// whatever ends this child.
						Effect.catch((cause) =>
							Effect.gen(function* () {
								yield* stop.release(current.child.handle);
								return interruptFailureOf(cause, yield* Ref.get(turnLive));
							}),
						),
					);
					if (refusal !== null) return refusal;
					yield* Fiber.await(current.child.fiber).pipe(
						Effect.andThen(Effect.flatMap(Ref.get(settings), respawn)),
					);
					return null;
				}),
			);
			// Published after the guard is given back, for the reason `respawn` announces outside its
			// own: a refusal is the window's cue that its turn is still live and its hand still free,
			// and a send answering it must not meet the guard of a relaunch that never started.
			if (refused !== null) yield* publish([{kind: "failure", failure: refused}]);
		}).pipe(Effect.withSpan("TuvalAiAgent.interrupt"));

		const setModel = Effect.fn("TuvalAiAgent.setModel")(function* (model: ModelRef) {
			const picked = offered.find((candidate) => sameModel(candidate, model));
			if (picked === undefined) {
				return yield* new ModelUnsupported({
					model: model.id,
					available: offered.map((row) => row.id),
				});
			}
			yield* respawn({...(yield* Ref.get(settings)), model: picked.id});
		});

		const setMode = Effect.fn("TuvalAiAgent.setMode")(function* (mode: Mode) {
			if (!isAgyMode(mode)) {
				return yield* new ModeUnsupported({mode, available: [...AGY_MODES]});
			}
			yield* respawn({...(yield* Ref.get(settings)), mode});
		});

		/**
		 * The tenth member, and a real control rather than a refusal.
		 *
		 * The brief mapped this to `ThinkingUnsupported` outright; the spike author corrected that
		 * with the measurement
		 * (<https://github.com/kamp-us/phoenix/issues/8182#issuecomment-5556810108>), and the
		 * measurement re-runs true: agy carries `--effort`, and
		 * `agy --print='/effort' --output-format=json` answers `["low","medium","high"]` for zero
		 * tokens. So the three it offers are switched the way the model and the mode are — by
		 * respawn — and only the four levels `ThinkingLevel` carries that agy has no counterpart for
		 * are refused, which is the contract #8062 set for every backend: offer what the backend
		 * really supports, never map a missing level onto a neighbour.
		 */
		const setThinkingLevel = Effect.fn("TuvalAiAgent.setThinkingLevel")(function* (
			level: ThinkingLevel,
		) {
			if (!isAgyEffort(level)) {
				return yield* new ThinkingUnsupported({level, available: [...AGY_EFFORTS]});
			}
			yield* respawn({...(yield* Ref.get(settings)), effort: level});
		});

		/**
		 * The picker's rows, read out of agy's own `/help` — its own invocation every time, never a
		 * line on the running session's stdin, which agy would refuse. It costs no tokens
		 * (`num_turns: 0`, every usage counter zero), so a fresh read is cheaper than a stale list. A
		 * read that would not answer keeps the last good catalog rather than emptying the picker.
		 */
		const commands = Effect.gen(function* () {
			const stdout = yield* runOneShot(commandArgv("help"));
			if (stdout === null) return yield* Ref.get(commandCache);
			const catalog = commandsOf(stdout);
			yield* Ref.set(commandCache, catalog);
			// One subscription, one ordering (ruling 1, #7570): a catalog change reaches the window
			// on the same stream every other catalog does, not down a second channel.
			yield* publish([{kind: "commands", available: catalog}]);
			return catalog;
		}).pipe(Effect.withSpan("TuvalAiAgent.commands"));

		const page = Effect.fn("TuvalAiAgent.page")(function* (before: string | null, limit: number) {
			const current = yield* Ref.get(session);
			if (current === null) {
				return yield* historyUnreadable("start has not opened an agy session on this layer");
			}
			const planned = yield* readTranscriptPage(
				{home, conversationId: current.conversationId},
				{before, limit},
			).pipe(Effect.provideService(FileSystem.FileSystem, filesystem));
			if (isRefusal(planned)) {
				if (planned.reason === "limit-not-positive") {
					// The port declares `limit > 0`; a caller that broke it has a bug this interface
					// does not model, exactly as the Pi and scripted layers treat it.
					return yield* Effect.die(
						new Error(`page was asked for ${limit} items; the port declares limit > 0`),
					);
				}
				return yield* unknownCursor(planned.reason);
			}
			return {items: planned.items, hasMore: planned.next !== null};
		});

		/**
		 * `page`'s answer with no session open (#8233) — and on this backend that is the whole of the
		 * difference, because agy's history is a plaintext log under `$HOME` keyed by conversation
		 * id, so reading it needs no child and no transport at all.
		 *
		 * `query.cwd` is unused, and that is a fact about agy's store rather than an omission: a
		 * conversation lives under its id in one brain directory whatever directory it was run from,
		 * so the cwd would narrow nothing.
		 *
		 * The conversation directory's presence is what separates the three answers. A directory
		 * that is there with no log yet is an empty conversation — a page — because agy writes the
		 * log as the turns run; a directory that is nowhere is a conversation this store does not
		 * hold; and a `$HOME` that would not answer at all is neither, and must not be spelled as
		 * either (`../../ai-agent/service/errors.ts`).
		 */
		const sessionTranscript = Effect.fn("TuvalAiAgent.sessionTranscript")(function* (
			query: TranscriptQuery,
		) {
			const held = yield* filesystem
				.exists(conversationDir(home, query.sessionId))
				.pipe(Effect.mapError((cause) => transcriptUnreadable(query.sessionId, cause)));
			if (!held) return yield* Effect.fail(transcriptSessionMissing(query.sessionId));
			const planned = yield* readTranscriptPage(
				{home, conversationId: query.sessionId},
				{before: query.before, limit: query.limit},
			).pipe(Effect.provideService(FileSystem.FileSystem, filesystem));
			if (isRefusal(planned)) {
				if (planned.reason === "limit-not-positive") {
					return yield* Effect.die(
						new Error(
							`sessionTranscript was asked for ${query.limit} items; the port declares limit > 0`,
						),
					);
				}
				return yield* transcriptUnknownCursor(query.sessionId, planned.reason);
			}
			return {items: planned.items, hasMore: planned.next !== null};
		});

		return {
			start,
			prompt,
			interrupt,
			/**
			 * Refused as data, by ruling rather than by omission (ADR 0362). Headless agy prompts on
			 * `/dev/tty` only, so it cannot ask and auto-denies instead: there is no permission card
			 * on this backend and therefore no request that could be answered. A silent success here
			 * would be a lie about a decision nobody was ever offered.
			 */
			answer: (request: string, _decision: PermissionDecision) =>
				Effect.fail(new UnknownRequest({request})),
			setMode,
			setModel,
			commands,
			setThinkingLevel,
			page,
			sessionTranscript,
			/**
			 * `unsupported` rather than `[]`, which is the distinction the reason exists for
			 * (`../../ai-agent/service/errors.ts`): agy's conversation store is not readable from
			 * here at this pin — nothing in `agy`'s headless surface enumerates conversations — so
			 * this backend has not looked, and must not tell the operator he has no agy sessions.
			 */
			listSessions: Effect.fail(
				new ListError({
					reason: "unsupported",
					detail: "the agy CLI offers no way to enumerate its conversations",
				}),
			).pipe(Effect.withSpan("TuvalAiAgent.listSessions")),
			events: withTurnResult(
				Stream.unwrap(Effect.map(Ref.get(queue), (held) => Stream.fromQueue(held))),
			),
		};
	});

/**
 * The layer's body over a spawner the caller provides, for the tests that need the subprocess to
 * behave a way the real one cannot be asked to — `interrupt-refusal.unit.test.ts` needs a `kill`
 * that is refused, and a live child never refuses one. Not a second entry point: `index.ts`
 * publishes the layer below and nothing else (`boundary.unit.test.ts`).
 */
export const aiAgentOverSpawner = make;

export const AgyAiAgent = {
	/**
	 * Ruling 4's layer (#7570). `R` is empty because the two platform services this needs — the
	 * child-process spawner and the filesystem the transcript reader reads through — are provided
	 * here rather than asked of the caller, and `E` is `never` because nothing is acquired at build
	 * time: agy is launched by `start` and torn down with this layer's scope.
	 */
	layer: (options: AgyAiAgentOptions = {}): Layer.Layer<TuvalAiAgent> =>
		Layer.effect(TuvalAiAgent, make(options)).pipe(
			Layer.provide(NodeChildProcessSpawner.layer),
			// The filesystem's Node implementation is itself `Path`-requiring, so the two are provided
			// together rather than the caller discovering the second one in a type error.
			Layer.provide(NodeFileSystem.layer),
			Layer.provide(NodePath.layer),
		),
} as const;
