/**
 * The GitHub boundary for `merge-queue-classify`: the live `Github` capability that reads
 * the two authoritative ground-truth signals ship-it Step 5.5's reconcile classifies on
 * (issue #1921), driving the IO-free `classify` core.
 *
 * Same service pattern as `verdict/github.ts` / `epic-ledger/github.ts`: a
 * `Context.Service` on `ChildProcessSpawner` (`.patterns/effect-process-cli-shell.md`),
 * `gh` REST only (GraphQL is broken on the kamp-us org), every infra failure a typed error
 * in the `E` channel (`GhCommandError` / `GhParseError` / `RepoResolutionError`), and the
 * untrusted `gh` JSON `Schema`-decoded at the boundary (`.patterns/effect-schema-validation.md`)
 * before it reaches the pure classifier. This replaces the prior `execFileSync` + swallowing
 * `catch { return null }` + unchecked `JSON.parse(...) as {…}` shell (#2738), so a fault surfaces
 * as a typed `E` the command handles rather than an invisible defect.
 *
 * One verb, `signals(pr)`, resolves the whole `MergeQueueSignals` input: the PR `state` +
 * `mergeStateStatus` from `gh pr view`, and the LAST merge-queue timeline event from
 * `gh api .../timeline`. The fail-closed-away-from-a-false-ship posture is preserved exactly:
 * an unreadable repo or PR state propagates as a typed error the command maps to `pending`, and
 * an unreadable timeline is deliberately recovered to "no event yet" (the settle window) — a
 * classifier miss can only ever keep polling, never report a false `merged`/`ejected`.
 */
import {Config, Context, Effect, Layer, Option, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {
	type LastMergeQueueEvent,
	lastMergeQueueEvent,
	type MergeQueueSignals,
} from "./merge-queue-classify.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/merge-queue-classify/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the reader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/merge-queue-classify/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/merge-queue-classify/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

// See `verdict/github.ts` `runGh` and `.patterns/effect-process-cli-shell.md`: spawn the handle
// directly (not `ChildProcessSpawner.string`, which hides the exit code), lower a non-zero exit
// into `GhCommandError`, and fold a spawn `PlatformError` (e.g. `gh` off PATH) into the same
// typed error at exit `-1` — the `E` channel carries only this package's errors, never a throw.
const runGh = Effect.fn("Github.runGh")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("gh", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		if (exitCode !== 0) {
			return yield* new GhCommandError({args, exitCode, stderr});
		}
		return stdout;
	},
	Effect.scoped,
	(effect, args) =>
		Effect.catchTag(
			effect,
			"PlatformError",
			(cause) => new GhCommandError({args, exitCode: -1, stderr: cause.message}),
		),
);

const parseJson = (
	args: ReadonlyArray<string>,
	raw: string,
): Effect.Effect<unknown, GhParseError> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * The env half of repo resolution (ADR 0062 §1), read via `Config` rather than `process.env`
 * (#2738): `CLAUDE_PIPELINE_REPO`, else `GITHUB_REPOSITORY` (CI). `Config.option` maps an unset
 * var to `None` instead of a `ConfigError`, so absence is a clean fall-through to `gh repo view`,
 * not a failure.
 */
const repoFromEnv = Config.string("CLAUDE_PIPELINE_REPO").pipe(
	Config.orElse(() => Config.string("GITHUB_REPOSITORY")),
	Config.option,
);

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`. Never silently defaults —
 * with no env and no resolvable current repo it fails `RepoResolutionError`. A broken config
 * provider degrades to the same fall-through as an unset var (`orElseSucceed(None)`), so the
 * method's `E` channel stays this package's own typed errors, never a `ConfigError`.
 */
const resolveRepo = Effect.fn("Github.resolveRepo")(function* () {
	const fromEnv = yield* repoFromEnv.pipe(Effect.orElseSucceed(() => Option.none<string>()));
	if (Option.isSome(fromEnv) && REPO_RE.test(fromEnv.value.trim())) {
		return fromEnv.value.trim();
	}
	const viewed = yield* runGh([
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"-q",
		".nameWithOwner",
	]).pipe(
		Effect.map((out) => out.trim()),
		Effect.catchTag("@kampus/merge-queue-classify/GhCommandError", () => Effect.succeed("")),
	);
	if (REPO_RE.test(viewed)) {
		return viewed;
	}
	return yield* new RepoResolutionError({
		message:
			"could not resolve a target repo: set CLAUDE_PIPELINE_REPO (or GITHUB_REPOSITORY), " +
			"or run inside a git repo whose origin `gh repo view` can read",
	});
});

// --- REST arg builders (REST only, never GraphQL) --------------------------------

/**
 * `gh pr view --json` for the two working fields (the old `merged` field errors
 * `Unknown JSON field` on this gh/repo, #1921); `merged` is derived from `state == MERGED`.
 */
const prStateArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"pr",
	"view",
	String(pr),
	"--repo",
	repo,
	"--json",
	"state,mergeStateStatus",
	"--jq",
	"{state: .state, mergeStateStatus: .mergeStateStatus}",
];

/** The REST issue-timeline endpoint (never GraphQL) — the authoritative queue-membership signal. */
const timelineArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${pr}/timeline?per_page=100`,
	"--paginate",
];

// --- boundary decoders -----------------------------------------------------------

/** The PR state as `gh pr view` returns it; `state`/`mergeStateStatus` may be absent or null. */
const RawPrState = Schema.Struct({
	state: Schema.optionalKey(Schema.NullOr(Schema.String)),
	mergeStateStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodePrState = Schema.decodeUnknownEffect(RawPrState);

/** A timeline entry as the issues/timeline endpoint returns it; only these fields are read. */
const RawTimelineEntry = Schema.Struct({
	event: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeTimeline = Schema.decodeUnknownEffect(Schema.Array(RawTimelineEntry));

/** The PR state read the classifier consumes — `merged` derived from `state == MERGED`. */
interface PrState {
	readonly merged: boolean;
	readonly state: string;
	readonly mergeStateStatus: string | undefined;
}

const toPrState = (raw: (typeof RawPrState)["Type"]): PrState => {
	const state = raw.state ?? "";
	return {
		merged: state === "MERGED",
		state,
		mergeStateStatus: raw.mergeStateStatus ?? undefined,
	};
};

// --- IO operations ---------------------------------------------------------------

const readPrState = Effect.fn("Github.readPrState")(function* (repo: string, pr: number) {
	const args = prStateArgs(repo, pr);
	return toPrState(yield* decodePrState(yield* parseJson(args, yield* runGh(args))));
});

/**
 * The LAST merge-queue timeline event, or `null` when the timeline carries none yet. An
 * unreadable timeline is DELIBERATELY recovered to `null` here — the fail-closed-away-from-a-
 * false-ship posture (#1921): a missing event reads as the enqueue-settle window (`pending`),
 * so a `gh`/parse/shape fault on the timeline can only keep polling, never trigger a false
 * ejection. The recovered errors are the typed `E` this read raises (not an untyped swallow):
 * the recovery is scoped to exactly `GhCommandError`/`GhParseError`/`SchemaError` at this one site.
 */
const readLastMergeQueueEvent = Effect.fn("Github.readLastMergeQueueEvent")(
	function* (repo: string, pr: number) {
		const args = timelineArgs(repo, pr);
		const raw = yield* runGh(args);
		// `--paginate` concatenates JSON arrays; normalize `][` joins into one array before parsing.
		const merged = raw.replace(/\]\s*\[/g, ",");
		const entries = yield* decodeTimeline(yield* parseJson(args, merged));
		// The core reads only `event` + `created_at`; project to its exact-optional shape, dropping
		// a null/absent field to an omitted key rather than an explicit `undefined`.
		return lastMergeQueueEvent(
			entries.map((e) => {
				const entry: {event?: string; created_at?: string} = {};
				if (e.event != null) entry.event = e.event;
				if (e.created_at != null) entry.created_at = e.created_at;
				return entry;
			}),
		);
	},
	(effect) =>
		effect.pipe(
			Effect.catchTags({
				"@kampus/merge-queue-classify/GhCommandError": () =>
					Effect.succeed<LastMergeQueueEvent>(null),
				"@kampus/merge-queue-classify/GhParseError": () =>
					Effect.succeed<LastMergeQueueEvent>(null),
				SchemaError: () => Effect.succeed<LastMergeQueueEvent>(null),
			}),
		),
);

const readSignals = Effect.fn("Github.signals")(function* (repo: string, pr: number) {
	const prState = yield* readPrState(repo, pr);
	const lastEvent = yield* readLastMergeQueueEvent(repo, pr);
	return {
		merged: prState.merged,
		state: prState.state,
		lastMergeQueueEvent: lastEvent,
		mergeStateStatus: prState.mergeStateStatus,
	} satisfies MergeQueueSignals;
});

/**
 * `Github` — the IO shell over `gh` REST for the reconcile's ground-truth reads. `signals(pr,
 * repoOverride?)` resolves the full `MergeQueueSignals` the pure `classify` consumes; a non-empty
 * `repoOverride` (the CLI `--repo` flag, ADR 0062 §1's highest precedence) wins over the resolved
 * repo, else the repo is resolved once (`RepoResolutionError`). An unreadable PR state propagates
 * typed (the command maps it to `pending`); an unreadable timeline is recovered to the settle
 * window. Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly signals: (
			pr: number,
			repoOverride?: string,
		) => Effect.Effect<
			MergeQueueSignals,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/merge-queue-classify/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at construction
 * and provided into each method body, so the public method carries `R = never`. Repo resolution
 * is deferred to first use (`Effect.cached`, ADR 0062 §1): the layer build is side-effect-free,
 * and `RepoResolutionError` lives in the method's `E` channel, raised only when `signals` reads —
 * and never at all when a `--repo` override short-circuits the resolution.
 */
export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				signals: (pr, repoOverride) => {
					const resolved =
						repoOverride !== undefined && repoOverride.trim() !== ""
							? Effect.succeed(repoOverride.trim())
							: repo;
					return resolved.pipe(Effect.flatMap((r) => withSpawner(readSignals(r, pr))));
				},
			};
		}),
	);
