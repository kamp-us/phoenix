/**
 * Commit stamping — close the one gap spike #235 found: crabbox seeds git and
 * resolves `HEAD` in-box but never surfaces the SHA, so ADR 0054 §1's
 * `bundle.commit == head SHA` binding isn't satisfied out of the box.
 *
 * `Git` is a `Context.Service` (`.patterns/effect-context-service.md`) whose live
 * layer runs `git rev-parse HEAD` over `ChildProcessSpawner`
 * (`effect/unstable/process`) and returns the trimmed SHA. A missing/empty SHA is
 * a hard `MissingCommitError` (ADR 0054 §1: `commit` is the binding key — never
 * blank), never a silent empty field. The caller may instead supply a known ref
 * (crabbox `--fresh-pr`), in which case this capability is not invoked.
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";

/** The head SHA could not be resolved (no git, detached/empty repo, blank `rev-parse`). */
export class MissingCommitError extends Schema.TaggedErrorClass<MissingCommitError>()(
	"@kampus/crabbox-manifest/MissingCommitError",
	{
		message: Schema.String,
	},
) {}

/**
 * The git capability the adapter uses to stamp `commit`. `headSha` resolves the
 * head SHA; a non-zero exit, a spawn fault, or an empty result is a
 * `MissingCommitError` (the SHA is the binding key — a blank one is a hard error,
 * per ADR 0054 §1 and #244's acceptance criteria). Like `epic-ledger`'s `Github`,
 * the `ChildProcessSpawner` dependency is the layer's `R`, not the method's, so
 * `headSha` carries `R = never`.
 */
export class Git extends Context.Service<
	Git,
	{
		readonly headSha: () => Effect.Effect<string, MissingCommitError>;
	}
>()("@kampus/crabbox-manifest/Git") {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const runGitRevParse = Effect.scoped(
	Effect.gen(function* () {
		const handle = yield* ChildProcess.make("git", ["rev-parse", "HEAD"]);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new MissingCommitError({
				message: `git rev-parse HEAD exited ${exitCode}: ${stderr.trim()}`,
			});
		}
		return stdout;
	}),
).pipe(
	Effect.catchTag(
		"PlatformError",
		(cause) =>
			new MissingCommitError({message: `could not run git rev-parse HEAD: ${cause.message}`}),
	),
);

const resolveHeadSha = Effect.fn("Git.headSha")(function* () {
	const sha = yield* runGitRevParse;
	const trimmed = sha.trim();
	if (trimmed.length === 0) {
		return yield* new MissingCommitError({message: "git rev-parse HEAD returned an empty SHA"});
	}
	return trimmed;
});

/**
 * The live `Git` layer. The `ChildProcessSpawner` dependency is captured once at
 * construction and provided into the method body, so `headSha` carries `R = never`;
 * provide the platform spawner (`NodeServices.layer`) to satisfy the layer's `R`.
 */
export const GitLive: Layer.Layer<Git, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Git)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			return {
				headSha: () => withSpawner(resolveHeadSha()),
			};
		}),
	);
