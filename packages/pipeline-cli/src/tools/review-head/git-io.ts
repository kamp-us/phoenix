/**
 * The `git` IO seam for `review-head` — the sibling of the tracker `gh-io.ts` `runGh`, for the
 * head-materialization git ops (`fetch` into a per-run ref, `rev-parse` the fetched ref, `worktree
 * add --detach`). `gh` head resolution reuses the shared `../tracker/gh-io.ts` seam; the git ops are
 * review-head-local, so their runner lives here rather than widening the shared gh seam with a `git`
 * verb. Same discipline: REST/porcelain only, a non-zero exit is a typed `GitCommandError`, never a throw.
 */
import {Effect, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess} from "effect/unstable/process";

/** A `git` invocation exited non-zero (an unreachable ref, a worktree-add collision, a detached-primary refusal, …). */
export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()(
	"@kampus/review-head/GitCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `git <args>` and return stdout, failing `GitCommandError` on a non-zero exit. Mirrors the
 * `gh-io.ts` `runGh` structure exactly (spawn directly to read `exitCode` + `stderr`, lower a
 * non-zero exit and any spawn/IO `PlatformError` into one typed error) so the two runners can't drift.
 */
export const runGit = Effect.fn("ReviewHead.runGit")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("git", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new GitCommandError({args, exitCode, stderr});
		}
		return stdout;
	},
	Effect.scoped,
	(effect, args) =>
		Effect.catchTag(
			effect,
			"PlatformError",
			(cause) => new GitCommandError({args, exitCode: -1, stderr: cause.message}),
		),
);
