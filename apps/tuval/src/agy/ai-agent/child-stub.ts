/**
 * One stubbed agy child, for the tests that drive this layer's real event path without a CLI.
 *
 * A stdout the test writes agy's own captured lines into, an exit that never comes, and a `kill`
 * that always says no. `exitCode` is `Effect.never` on purpose — an exit is what ends `events` with
 * a transport failure, and a refusal must not be confused with the child having gone away.
 */

import {NodeFileSystem, NodePath} from "@effect/platform-node";
import {Effect, Layer, Queue, Ref, Sink, Stream} from "effect";
import * as PlatformError from "effect/PlatformError";
import {ChildProcessSpawner} from "effect/unstable/process";
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

/** The layer under test over one stubbed child, with the platform services `make` asks for. */
export const agyLayerOver = (child: {
	readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
}): Layer.Layer<TuvalAiAgent> =>
	Layer.effect(TuvalAiAgent, aiAgentOverSpawner({binary: "agy", home: "/tuval/agy-home"})).pipe(
		Layer.provide(child.layer),
		Layer.provide(NodeFileSystem.layer),
		Layer.provide(NodePath.layer),
	);
