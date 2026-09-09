/**
 * An agy `SIGINT` the platform would not deliver, over the layer's real event path (ADR 0356).
 *
 * The same contract the three peer adapters owe, proved separately because agy answers it from a
 * third place: the refusal is a failed `kill` rather than a refused control request, and `reason`
 * comes off this layer's own memory of having sent a turn — agy's wire says nothing about the turn
 * at all, which is the measurement ADR 0362 records. A layer that read the reason wrong would send
 * the fold to the other arm and walk a running turn to `ready`.
 *
 * Limits of the proof: the spawner is a stub, so what runs is the mapping from a refused `kill` to
 * the event the core folds — not a real SIGINT, and not the conditions under which the operating
 * system refuses to deliver one. A live child never refuses a signal on demand, which is why the
 * subprocess is the part that is faked here and the layer is not.
 */

import {NodeFileSystem, NodePath} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Queue, Ref, Sink, Stream} from "effect";
import * as PlatformError from "effect/PlatformError";
import {ChildProcessSpawner} from "effect/unstable/process";
import type {AgentEvent} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {aiAgentOverSpawner} from "./AgyAiAgent.ts";
import {init, responseDone, resultSuccess, userInput} from "./fixtures.ts";

const CWD = "/tuval/agy-interrupt-refusal";

const KILL_REFUSED = PlatformError.systemError({
	_tag: "PermissionDenied",
	module: "ChildProcess",
	method: "kill",
	description: "operation not permitted",
});

const encoder = new TextEncoder();

/**
 * One stubbed child: a stdout the test writes agy's own captured lines into, an exit that never
 * comes, and a `kill` that always says no.
 *
 * `exitCode` is `Effect.never` on purpose — an exit is what ends `events` with a transport failure,
 * and a refusal must not be confused with the child having gone away.
 */
const stub = Effect.gen(function* () {
	const stdout = yield* Queue.unbounded<Uint8Array>();
	// Open and silent, never `Stream.empty`: `follow` races the stdout drain against the stderr one,
	// and a stderr that completes at once wins that race and ends the fan before a line is read.
	const stderr = yield* Queue.unbounded<Uint8Array>();
	const kills = yield* Ref.make(0);
	const handle: ChildProcessSpawner.ChildProcessHandle = ChildProcessSpawner.makeHandle({
		pid: ChildProcessSpawner.ProcessId(424_242),
		exitCode: Effect.never,
		isRunning: Effect.succeed(true),
		kill: () =>
			Effect.flatMap(
				Ref.update(kills, (seen) => seen + 1),
				() => Effect.fail(KILL_REFUSED),
			),
		stdin: Sink.drain,
		stdout: Stream.fromQueue(stdout),
		stderr: Stream.fromQueue(stderr),
		all: Stream.fromQueue(stderr),
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		unref: Effect.succeed(Effect.void),
	});
	return {
		layer: Layer.succeed(
			ChildProcessSpawner.ChildProcessSpawner,
			ChildProcessSpawner.make(() => Effect.succeed(handle)),
		),
		/** One agy stdout line, as the fan reads it. */
		say: (line: string) => Queue.offer(stdout, encoder.encode(`${line}\n`)),
		kills: Ref.get(kills),
	};
});

/** The layer under test over one stubbed child, with the platform services `make` asks for. */
const layerOver = (child: {
	readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
}): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(TuvalAiAgent, aiAgentOverSpawner({binary: "agy", home: "/tuval/agy-home"})).pipe(
		Layer.provide(child.layer),
		Layer.provide(NodeFileSystem.layer),
		Layer.provide(NodePath.layer),
	);

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

const isReady = (event: AgentEvent): boolean => event.kind === "phase" && event.phase === "ready";
const isPrompting = (event: AgentEvent): boolean =>
	event.kind === "phase" && event.phase === "prompting";
const isFailure = (event: AgentEvent): boolean => event.kind === "failure";

const failureOf = (events: ReadonlyArray<AgentEvent>) => {
	const one = events.at(-1);
	assert.isTrue(one?.kind === "failure", "the last event collected is not the refusal");
	return (one as Extract<AgentEvent, {kind: "failure"}>).failure;
};

describe("an agy SIGINT the child would not take", () => {
	it.live("reaches the core as its own failure tag rather than a log line", () =>
		Effect.gen(function* () {
			const child = yield* stub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				yield* collectTo(events, "the opened session's ready", isReady);

				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* agent.interrupt;

				const failure = failureOf(yield* collectTo(events, "the refused signal", isFailure));
				assert.strictEqual(
					yield* child.kills,
					1,
					"the layer reported a refusal it never asked for",
				);
				assert.strictEqual(failure.tag, "tuval/ai-agent/InterruptError");
				assert.strictEqual(failure.reason, "turn-running");
				assert.include(failure.detail, "agy refused to interrupt the turn");
			}).pipe(Effect.provide(layerOver(child)), Effect.scoped);
		}),
	);

	// A refusal is not a turn ending: nothing the layer emits for it may read as one, because the
	// phase is what the window's stop control and its Escape branch key on.
	it.live("narrates no phase change of its own", () =>
		Effect.gen(function* () {
			const child = yield* stub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				yield* collectTo(events, "the opened session's ready", isReady);
				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* agent.interrupt;

				const after = yield* collectTo(events, "the refused signal", isFailure);
				assert.isEmpty(
					after.filter((event) => event.kind === "phase"),
					"the refusal narrated a phase the backend never entered",
				);
			}).pipe(Effect.provide(layerOver(child)), Effect.scoped);
		}),
	);

	// The other half the fold routes on: the turn's `result` has landed, so there was nothing left
	// to stop and the session is owed its way back to `ready`.
	it.live("says there was no live turn once the result has landed", () =>
		Effect.gen(function* () {
			const child = yield* stub;
			yield* child.say(init);

			yield* Effect.gen(function* () {
				const agent = yield* TuvalAiAgent;
				const events = yield* Stream.toQueue(agent.events, {capacity: "unbounded"});
				yield* agent.start({cwd: CWD});
				yield* collectTo(events, "the opened session's ready", isReady);
				yield* agent.prompt("say hello");
				yield* collectTo(events, "the turn's prompting", isPrompting);
				yield* child.say(userInput);
				yield* child.say(responseDone);
				yield* child.say(resultSuccess);
				yield* collectTo(events, "the turn's own end", isReady);
				yield* agent.interrupt;

				const failure = failureOf(yield* collectTo(events, "the refused signal", isFailure));
				assert.strictEqual(failure.reason, "no-live-turn");
			}).pipe(Effect.provide(layerOver(child)), Effect.scoped);
		}),
	);
});
