/**
 * What an agy stop leaves behind, over the layer's real event path (#8709).
 *
 * A SIGINT agy takes ends the child, so the session the window holds survives only if the layer
 * relaunches it — and the relaunch has to be the one `setModel` already uses, because that is the
 * one that keeps the conversation id and the event queue. Three facts make that true and are
 * asserted separately: the second launch carries `--conversation=<id>`, the phase the window ends on
 * is `ready`, and the stream the window subscribed to is still the same live stream afterwards.
 *
 * Limits of the proof: the spawner is a stub, so the signal is recorded rather than delivered and
 * the exit is the test's. What is real is everything above the pipe — `follow`'s fold, the exit
 * watch's own reading of the stop, and `respawn`. The scripted binary beside this file
 * (`agy-ai-agent.integration.test.ts`) drives the same path over a real SIGINT and a real exit.
 */

import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Fiber, Option, Queue, Scheduler, Stream} from "effect";
import type {AgentEvent, StartError} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {agyChildrenStub, agyLayerOver, type StubChild} from "./child-stub.ts";
import {init, resultInterrupted, userInput} from "./fixtures.ts";

const CWD = "/tuval/agy-interrupt-respawn";

/** The conversation id the captured `init` line opens, which is what a relaunch has to carry. */
const CONVERSATION = "9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf";

/** Every event up to and including the first one `found` accepts, bounded so a miss names itself. */
const collectTo = (
	events: Queue.Dequeue<AgentEvent, unknown>,
	what: string,
	found: (event: AgentEvent) => boolean,
) =>
	Effect.gen(function* () {
		const seen: Array<AgentEvent> = [];
		while (true) {
			const next = yield* Queue.take(events).pipe(Effect.orDie, Effect.timeoutOption("5 seconds"));
			if (Option.isNone(next)) {
				assert.fail(`timed out waiting for ${what}; saw ${JSON.stringify(seen)}`);
			}
			seen.push(next.value);
			if (found(next.value)) return seen;
		}
	});

/** Waits until the stop has reached the child, so what follows is ordered after the signal. */
const signalled = (child: StubChild): Effect.Effect<void> =>
	Effect.flatMap(child.signals, (seen) =>
		seen.length === 0 ? Effect.andThen(Effect.sleep("5 millis"), signalled(child)) : Effect.void,
	).pipe(
		Effect.timeoutOrElse({
			duration: "5 seconds",
			orElse: () => Effect.die(new Error("the stop sent no signal")),
		}),
	);

/** The refusal a failed call carries, as the two fields a test asserts on. */
const causeError = (exit: Exit.Exit<unknown, unknown>): {_tag?: string; reason?: string} =>
	Exit.isFailure(exit)
		? ((Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? {}) as {
				_tag?: string;
				reason?: string;
			})
		: {};

/** Every line one stub child really took on stdin, waited for rather than sampled once. */
const writtenTo = (child: StubChild): Effect.Effect<ReadonlyArray<string>> =>
	Effect.flatMap(child.written, (lines) =>
		lines.length === 0
			? Effect.andThen(Effect.sleep("5 millis"), writtenTo(child))
			: Effect.succeed(lines),
	).pipe(
		Effect.timeoutOrElse({
			duration: "5 seconds",
			orElse: () => Effect.succeed<ReadonlyArray<string>>([]),
		}),
	);

const isReady = (event: AgentEvent): boolean => event.kind === "phase" && event.phase === "ready";
const isPrompting = (event: AgentEvent): boolean =>
	event.kind === "phase" && event.phase === "prompting";
const isInterruptedItem = (event: AgentEvent): boolean =>
	event.kind === "item" && event.item.kind === "assistant" && event.item.interrupted === true;

describe("an agy turn the operator stops", () => {
	/**
	 * One opened session over a relaunching stub. `start` awaits `init`, and the child it awaits does
	 * not exist until the launch — so the launch is forked and the line written into the child it
	 * produced.
	 */
	const opened = (children: {
		readonly child: (index: number) => Effect.Effect<StubChild>;
	}): Effect.Effect<void, StartError, TuvalAiAgent> =>
		Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			const starting = yield* Effect.forkChild(agent.start({cwd: CWD}));
			yield* Effect.flatMap(children.child(0), (child) => child.say(init));
			yield* Fiber.join(starting);
		});

	it.live("comes back on the same conversation, on the same stream, at ready", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* opened(children);
				// Subscribed after the open, because `start` replaces the queue it opened on: a
				// subscription taken before it is reading a queue `start` shuts down.
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.prompt("something long");
				yield* collectTo(events, "the turn's prompting", isPrompting);

				// The stop, as the wire and the process really order it: the signal lands, agy writes
				// its terminal `result` naming the stop, and only then does the child exit.
				const stopping = yield* Effect.forkChild(agent.interrupt);
				const first = yield* children.child(0);
				yield* signalled(first);
				// An impatient second press, which the core does dispatch: the phase is still
				// `prompting` until the terminal `result` lands. It has nothing left to send, and a
				// second signal would take the first one's relaunch down with the queue.
				yield* agent.interrupt;
				yield* first.say(userInput);
				yield* first.say(resultInterrupted);
				yield* first.exit(1);
				// The relaunch is in flight behind the exit, and it is waiting on its own `init`.
				yield* Effect.flatMap(children.child(1), (child) => child.say(init));
				yield* Fiber.join(stopping);

				const launches = yield* children.launches;
				assert.strictEqual(launches.length, 2, "the stop did not relaunch the child");
				assert.include(launches[1] ?? [], `--conversation=${CONVERSATION}`);
				assert.deepStrictEqual(
					yield* first.signals,
					["SIGINT"],
					"the stop sent something other than one SIGINT",
				);

				// The queue the window subscribed to before the stop is the one still answering: a
				// `gone` or a failed take here is the subscription the relaunch exists to keep.
				const after = yield* collectTo(events, "the session back at ready", isReady);
				assert.isEmpty(
					after.filter((event) => event.kind === "phase" && event.phase === "gone"),
					"the stop narrated a session the layer went on to relaunch",
				);
				assert.isTrue(
					after.some(isInterruptedItem),
					"the cut reply lost its interrupted mark across the relaunch",
				);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);

	/**
	 * Two stops that interleave, rather than one after the other.
	 *
	 * The sequential second press is covered above; this is the one a read-then-write guard lets
	 * through (#8883). Two forked `interrupt` fibers would otherwise each run their synchronous steps
	 * straight to the first async boundary and never interleave, so the yield budget is cut to 3: at
	 * that value the run loop really does suspend one fiber inside the guard — with the read-then-write
	 * guard in place this test sees two SIGINTs and three launches. Three, not 1 or 2, because a
	 * budget under 3 starves the fibers entirely and no signal is ever sent.
	 */
	it.live("claims the stop once when two presses interleave", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* opened(children);
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.prompt("something long");
				yield* collectTo(events, "the turn's prompting", isPrompting);

				const stopping = yield* Effect.forkChild(
					Effect.all([agent.interrupt, agent.interrupt], {
						concurrency: "unbounded",
						discard: true,
					}).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)),
				);
				const first = yield* children.child(0);
				yield* signalled(first);
				yield* first.say(userInput);
				yield* first.say(resultInterrupted);
				yield* first.exit(1);
				yield* Effect.flatMap(children.child(1), (child) => child.say(init));
				yield* Fiber.join(stopping);

				assert.deepStrictEqual(
					yield* first.signals,
					["SIGINT"],
					"an interleaved second press sent its own signal",
				);
				const launches = yield* children.launches;
				assert.strictEqual(
					launches.length,
					2,
					"the interleaved presses relaunched more than once: the child the first stop reopened was torn down again",
				);
				assert.include(launches[1] ?? [], `--conversation=${CONVERSATION}`);
				const after = yield* collectTo(events, "the session back at ready", isReady);
				assert.isEmpty(
					after.filter((event) => event.kind === "phase" && event.phase === "gone"),
					"the second press narrated a session the layer went on to keep",
				);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);

	/**
	 * Where the window is, and what is in it.
	 *
	 * Driven to the one instant the issue's own flow lands in: the terminal `result` has published
	 * `ready`, so the operator's hand is free, and the relaunch is past its teardown and waiting on the
	 * new child's `init`. `session` holds the torn-down child there — its stdin queue is shut down, and
	 * an offer onto a queue that is not `Open` answers `false` rather than failing, so a send admitted
	 * here would be dropped with its key burned and nothing left to settle it (#8709). Returns the
	 * stopped child, the relaunching one, and the stop still in flight.
	 */
	const inTheRelaunchWindow = (children: {
		readonly child: (index: number) => Effect.Effect<StubChild>;
		readonly launches: Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>;
	}) =>
		Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			yield* opened(children);
			const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
			yield* agent.prompt("something long");
			yield* collectTo(events, "the turn's prompting", isPrompting);

			const stopping = yield* Effect.forkChild(agent.interrupt);
			const first = yield* children.child(0);
			yield* signalled(first);
			yield* first.say(userInput);
			yield* first.say(resultInterrupted);
			yield* collectTo(events, "the stop's ready", isReady);
			yield* first.exit(1);
			const second = yield* children.child(1);
			return {agent, events, stopping, first, second};
		});

	it.live("refuses a send that arrives inside the relaunch, and writes it to no stdin", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const {agent, first, second, stopping} = yield* inTheRelaunchWindow(children);

				const refused = causeError(yield* Effect.exit(agent.prompt("resent text", "resend-key")));
				assert.strictEqual(
					refused._tag,
					"tuval/ai-agent/PromptError",
					"the send inside the relaunch was admitted",
				);
				// `no-session` and not `disconnected`: `sends.ts` settles the first `refused` and the
				// second `uncertain`, and only `refused` renders the unsent bar the text comes back from.
				assert.strictEqual(refused.reason, "no-session");
				assert.deepStrictEqual(
					(yield* first.written).filter((line) => line.includes("resent text")),
					[],
					"the refused send was written to the torn-down child's stdin",
				);

				yield* second.say(init);
				yield* Fiber.join(stopping);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);

	it.live("closes the window: the next send crosses on the child the relaunch opened", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const {agent, events, second, stopping} = yield* inTheRelaunchWindow(children);
				// Refused first, so the key this send carries is one a refusal has already been asked
				// to leave unburned — a send dropped silently would have burned it and this would be
				// deduped into nothing.
				yield* Effect.exit(agent.prompt("resent text", "resend-key"));

				yield* second.say(init);
				yield* Fiber.join(stopping);
				yield* collectTo(events, "the relaunched session at ready", isReady);

				yield* agent.prompt("resent text", "resend-key");
				const crossed = yield* writtenTo(second);
				assert.isTrue(
					crossed.some((line) => line.includes("resent text")),
					`the send after the relaunch reached no child; saw ${JSON.stringify(crossed)}`,
				);
				assert.strictEqual(
					(yield* children.launches).length,
					2,
					"the send after the relaunch launched a child of its own",
				);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);

	// The other half of the exit watch's reading: an exit nobody asked for is still a transport that
	// is gone, and the window is still owed the `gone` and the failed stream.
	it.live("still reports an exit the layer did not ask for", () =>
		Effect.gen(function* () {
			const children = yield* agyChildrenStub;

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				yield* opened(children);
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});

				const first = yield* children.child(0);
				yield* first.exit(1);

				yield* collectTo(
					events,
					"the gone phase",
					(event) => event.kind === "phase" && event.phase === "gone",
				);
				const failed = yield* Effect.result(Queue.take(events));
				assert.isTrue(failed._tag === "Failure", "the dead transport left the stream live");
				assert.strictEqual(
					(yield* children.launches).length,
					1,
					"the layer relaunched a child it never stopped",
				);
			}).pipe(Effect.provide(agyLayerOver(children)), Effect.scoped);
		}),
	);
});
