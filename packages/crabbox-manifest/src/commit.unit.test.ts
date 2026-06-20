/**
 * `Git.headSha` over a fake `ChildProcessSpawner` — the capability-seam test
 * (#855). The never-blank-commit guard (ADR 0054 §1) has three
 * `MissingCommitError` paths and a happy path; this crosses the IO seam
 * (`.patterns/effect-context-service.md`) with the `mockSpawner` idiom from
 * `@kampus/epic-ledger`'s `github-service.unit.test.ts`, so all four are
 * reachable without spawning real `git`:
 *   - rev-parse exits non-zero,
 *   - the spawn itself faults (a `PlatformError` — no `git` on PATH),
 *   - rev-parse returns a blank SHA,
 *   - rev-parse returns a SHA (trimmed) — the happy path.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import * as PlatformError from "effect/PlatformError";
import {ChildProcessSpawner} from "effect/unstable/process";
import {Git, GitLive, MissingCommitError} from "./commit.ts";

const enc = new TextEncoder();

interface Canned {
	readonly stdout: string;
	readonly exitCode?: number;
	readonly stderr?: string;
}

/** A spawner that answers every `git` invocation with one canned result. */
const cannedSpawner = (canned: Canned): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* () {
				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(1),
					stdin: Sink.drain,
					stdout: Stream.fromIterable([enc.encode(canned.stdout)]),
					stderr: Stream.fromIterable([enc.encode(canned.stderr ?? "")]),
					all: Stream.fromIterable([enc.encode(canned.stdout)]),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(canned.exitCode ?? 0)),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
			}),
		),
	);

/**
 * A spawner whose spawn itself fails with a `PlatformError` — the "no `git` on
 * PATH" fault `commit.ts` folds into a `MissingCommitError` via its
 * `catchTag("PlatformError", …)`.
 */
const faultingSpawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
)(
	ChildProcessSpawner.make(() =>
		Effect.fail(
			PlatformError.badArgument({
				module: "ChildProcess",
				method: "spawn",
				description: "spawn git ENOENT",
			}),
		),
	),
);

const headSha = (spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
	Git.pipe(Effect.flatMap((git) => git.headSha())).pipe(
		Effect.provide(GitLive.pipe(Layer.provide(spawner))),
	);

describe("GitLive.headSha — over a fake spawner (ADR 0054 §1: commit never blank)", () => {
	it.effect("happy path: returns the trimmed head SHA", () =>
		Effect.gen(function* () {
			const sha = yield* headSha(cannedSpawner({stdout: "deadbeefcafebabe\n"}));
			assert.strictEqual(sha, "deadbeefcafebabe");
		}),
	);

	it.effect("a non-zero rev-parse exit is a MissingCommitError", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				headSha(cannedSpawner({stdout: "", exitCode: 128, stderr: "fatal: not a git repository"})),
			);
			assert.isTrue(error instanceof MissingCommitError);
			assert.include(error.message, "exited 128");
		}),
	);

	it.effect("a spawn fault (no git on PATH) is a MissingCommitError", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(headSha(faultingSpawner));
			assert.isTrue(error instanceof MissingCommitError);
			assert.include(error.message, "could not run git rev-parse HEAD");
		}),
	);

	it.effect("a blank SHA (whitespace only) is a MissingCommitError", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(headSha(cannedSpawner({stdout: "   \n"})));
			assert.isTrue(error instanceof MissingCommitError);
			assert.include(error.message, "empty SHA");
		}),
	);
});
