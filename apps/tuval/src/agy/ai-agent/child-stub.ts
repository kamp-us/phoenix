/**
 * Stubbed agy children, for the tests that drive this layer's real event path without a CLI.
 *
 * `agyChildStub` is one child whose `kill` always says no: a stdout the test writes agy's own
 * captured lines into, and an exit that never comes. `exitCode` is `Effect.never` on purpose — an
 * exit is what ends `events` with a transport failure, and a refusal must not be confused with the
 * child having gone away.
 *
 * `agyChildrenStub` is the other half, for a stop that is taken: a child per launch, each with the
 * argv it was launched with, a `kill` that records the signal and resolves on the exit the test
 * then gives it, and pipes that close with that exit. The resolve-on-exit is not a convenience —
 * the real `kill` awaits the exit it asked for
 * (`@effect/platform-node-shared`'s `NodeChildProcessSpawner`), which is the ordering
 * `interrupt`'s relaunch stands on.
 */

import {NodeFileSystem, NodePath} from "@effect/platform-node";
import {type Cause, Deferred, Effect, Layer, Queue, Ref, Sink, Stream} from "effect";
import * as PlatformError from "effect/PlatformError";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {aiAgentOverSpawner} from "./AgyAiAgent.ts";

const KILL_REFUSED = PlatformError.systemError({
	_tag: "PermissionDenied",
	module: "ChildProcess",
	method: "kill",
	description: "operation not permitted",
});

const encoder = new TextEncoder();

export const agyChildStub = Effect.gen(function* () {
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

/** One launched stub child, and the four things a test does to it. */
export interface StubChild {
	/** One agy stdout line, as the fan reads it. */
	readonly say: (line: string) => Effect.Effect<void>;
	/** Every signal `kill` was asked for, in order. */
	readonly signals: Effect.Effect<ReadonlyArray<string>>;
	/** The exit a delivered signal earns: the pipes end, then the code lands. */
	readonly exit: (code: number) => Effect.Effect<void>;
	/**
	 * Every line that really crossed this child's stdin, decoded. A send the layer dropped onto a
	 * shut-down queue is absent here, which is the only way a test can tell it apart from one that
	 * landed (#8709).
	 */
	readonly written: Effect.Effect<ReadonlyArray<string>>;
}

const decoder = new TextDecoder();

const stubChild = Effect.gen(function* () {
	const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
	// Open and silent, never `Stream.empty`: `follow` races the stdout drain against the stderr one,
	// and a stderr that completes at once wins that race and ends the fan before a line is read.
	const stderr = yield* Queue.unbounded<Uint8Array, Cause.Done>();
	const signals = yield* Ref.make<ReadonlyArray<string>>([]);
	const written = yield* Ref.make<ReadonlyArray<string>>([]);
	const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
	const exit = (code: number): Effect.Effect<void> =>
		Queue.end(stdout).pipe(
			Effect.andThen(Queue.end(stderr)),
			Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(code))),
			Effect.asVoid,
		);
	const handle: ChildProcessSpawner.ChildProcessHandle = ChildProcessSpawner.makeHandle({
		pid: ChildProcessSpawner.ProcessId(424_243),
		exitCode: Deferred.await(exited),
		isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
		kill: (options) =>
			Ref.update(signals, (seen) => [...seen, options?.killSignal ?? "SIGTERM"]).pipe(
				Effect.andThen(Deferred.await(exited)),
				Effect.asVoid,
			),
		stdin: Sink.drain,
		stdout: Stream.fromQueue(stdout),
		stderr: Stream.fromQueue(stderr),
		all: Stream.fromQueue(stderr),
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		unref: Effect.succeed(Effect.void),
	});
	const child: StubChild = {
		say: (line: string) => Effect.asVoid(Queue.offer(stdout, encoder.encode(`${line}\n`))),
		signals: Ref.get(signals),
		exit,
		written: Ref.get(written),
	};
	return {handle, child, written};
});

/** A spawner that launches a fresh stub child every time, which is what a respawn asks of it. */
export const agyChildrenStub = Effect.gen(function* () {
	const launched = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
	const children = yield* Ref.make<ReadonlyArray<StubChild>>([]);
	const spawn = Effect.fnUntraced(function* (command: ChildProcess.Command) {
		const {handle, child, written} = yield* stubChild;
		const argv = ChildProcess.isStandardCommand(command) ? [...command.args] : [];
		// The real spawner runs the command's input stream into the child's stdin; a stub that only
		// hands back a handle never consumes it, and then no test can see which child a send reached.
		// Forked into the spawn's own scope, so it dies with the child like the real pipe does.
		const input = ChildProcess.isStandardCommand(command) ? command.options.stdin : undefined;
		const piped =
			typeof input === "object" && input !== null && "stream" in input ? input.stream : input;
		if (typeof piped === "object" && piped !== null) {
			yield* Effect.forkScoped(
				Stream.runForEach(piped, (bytes) =>
					Ref.update(written, (seen) => [...seen, decoder.decode(bytes)]),
				).pipe(Effect.ignore),
			);
		}
		yield* Ref.update(launched, (seen) => [...seen, argv]);
		yield* Ref.update(children, (seen) => [...seen, child]);
		return handle;
	});
	/** The nth child, waited for: a relaunch is in flight when the test goes looking for it. */
	const childAt = (index: number): Effect.Effect<StubChild> =>
		Effect.flatMap(Ref.get(children), (seen) => {
			const one = seen[index];
			return one === undefined
				? Effect.andThen(Effect.sleep("5 millis"), childAt(index))
				: Effect.succeed(one);
		});
	return {
		layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
		child: (index: number) =>
			childAt(index).pipe(
				Effect.timeoutOrElse({
					duration: "5 seconds",
					orElse: () => Effect.die(new Error(`no child was launched at index ${index}`)),
				}),
			),
		/** Every launch's argv, in order. */
		launches: Ref.get(launched),
	};
});

/**
 * The layer under test over one stubbed child, with the platform services `make` asks for.
 *
 * `home` defaults to a path nothing is written under, which is all a test of the event path needs.
 * A test of the store reads — `sessionTranscript`, whose answers turn on what is on disk under the
 * home — hands a disposable directory instead, because the default cannot be made to hold a
 * conversation and the real `$HOME` must never be read.
 */
export const agyLayerOver = (
	child: {
		readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
	},
	home = "/tuval/agy-home",
): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(TuvalAiAgent, aiAgentOverSpawner({binary: "agy", home})).pipe(
		Layer.provide(child.layer),
		Layer.provide(NodeFileSystem.layer),
		Layer.provide(NodePath.layer),
	);
