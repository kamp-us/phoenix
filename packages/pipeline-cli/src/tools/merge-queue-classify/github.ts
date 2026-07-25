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
 * `mergeStateStatus` + `baseRefName` from `gh pr view`, the LAST merge-queue timeline event from
 * `gh api .../timeline`, and — when the PR does not already read merged — whether the base branch
 * carries the PR's squash, from `gh api .../commits?sha=<base>` (#4057). The
 * fail-closed-away-from-a-false-ship posture is preserved exactly: an unreadable repo or PR state
 * propagates as a typed error the command maps to `pending`; an unreadable timeline is deliberately
 * recovered to "no event yet" (the settle window); an unreadable base branch is recovered to
 * `unreadable`, which carries no evidence. A read fault can only ever keep polling, never report a
 * false `merged`/`ejected`.
 *
 * The PR field this boundary deliberately does NOT read is `merge_commit_sha`: on an OPEN PR it
 * holds GitHub's throwaway *test-merge* commit, so it is evidence of nothing. The load-bearing
 * merge signals are `merged`/`merged_at` (here: `state == MERGED`) and the single-parent squash on
 * the base branch. Do not "improve" this read by comparing `merge_commit_sha` to the base tip.
 */
import {Config, Context, Effect, Layer, Option, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {
	type BaseBranchSquash,
	type LastMergeQueueEvent,
	lastMergeQueueEvent,
	type MergeQueueSignals,
	squashOnBaseBranch,
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

// REST-only arg builders — never GraphQL.

/**
 * `gh pr view --json` for the three working fields (the old `merged` field errors
 * `Unknown JSON field` on this gh/repo, #1921); `merged` is derived from `state == MERGED`.
 * `baseRefName` names the branch the squash cross-check scans (#4057).
 */
const prStateArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"pr",
	"view",
	String(pr),
	"--repo",
	repo,
	"--json",
	"state,mergeStateStatus,baseRefName",
	"--jq",
	"{state: .state, mergeStateStatus: .mergeStateStatus, baseRefName: .baseRefName}",
];

/** The REST issue-timeline endpoint (never GraphQL) — the authoritative queue-membership signal. */
const timelineArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${pr}/timeline?per_page=100`,
	"--paginate",
];

/**
 * The scan window of the base-branch squash cross-check: the base branch's most recent commits.
 * Bounded on purpose — the window only has to span the staleness it corrects (~30–60 min observed,
 * a few dozen commits at fleet pace), and an unbounded `--paginate` walk would grow with repo age
 * on every poll. A squash older than the window reads `absent`, which is the no-evidence value.
 */
const BASE_BRANCH_SCAN = 100;

/** REST list-commits on the base branch, projected to the two fields the squash predicate reads. */
const baseCommitsArgs = (repo: string, base: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/commits?sha=${base}&per_page=${BASE_BRANCH_SCAN}`,
	"--jq",
	"[.[] | {message: .commit.message, parents: (.parents | length)}]",
];

/** The PR state as `gh pr view` returns it; every field may be absent or null. */
const RawPrState = Schema.Struct({
	state: Schema.optionalKey(Schema.NullOr(Schema.String)),
	mergeStateStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
	baseRefName: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodePrState = Schema.decodeUnknownEffect(RawPrState);

/** A timeline entry as the issues/timeline endpoint returns it; only these fields are read. */
const RawTimelineEntry = Schema.Struct({
	event: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeTimeline = Schema.decodeUnknownEffect(Schema.Array(RawTimelineEntry));

/** A base-branch commit as the `--jq` projection above emits it. */
const RawBaseCommit = Schema.Struct({
	message: Schema.optionalKey(Schema.NullOr(Schema.String)),
	parents: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const decodeBaseCommits = Schema.decodeUnknownEffect(Schema.Array(RawBaseCommit));

/** The PR state read the classifier consumes — `merged` derived from `state == MERGED`. */
interface PrState {
	readonly merged: boolean;
	readonly state: string;
	readonly mergeStateStatus: string | undefined;
	readonly baseRefName: string;
}

const toPrState = (raw: (typeof RawPrState)["Type"]): PrState => {
	const state = raw.state ?? "";
	return {
		merged: state === "MERGED",
		state,
		mergeStateStatus: raw.mergeStateStatus ?? undefined,
		baseRefName: raw.baseRefName ?? "",
	};
};

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

/**
 * Whether the base branch carries this PR's squash (#4057). An unreadable base branch recovers to
 * `unreadable` for the same fail-closed reason the timeline recovers to the settle window: no
 * evidence never promotes a verdict, so a fault here can only leave the reconcile polling.
 */
const readBaseBranchSquash = Effect.fn("Github.readBaseBranchSquash")(
	function* (repo: string, pr: number, base: string) {
		if (base === "") return "unreadable" as const;
		const args = baseCommitsArgs(repo, base);
		const commits = yield* decodeBaseCommits(yield* parseJson(args, yield* runGh(args)));
		return squashOnBaseBranch(
			commits.map((c) => ({message: c.message ?? undefined, parents: c.parents ?? undefined})),
			pr,
		);
	},
	(effect) =>
		effect.pipe(
			Effect.catchTags({
				"@kampus/merge-queue-classify/GhCommandError": () =>
					Effect.succeed<BaseBranchSquash>("unreadable"),
				"@kampus/merge-queue-classify/GhParseError": () =>
					Effect.succeed<BaseBranchSquash>("unreadable"),
				SchemaError: () => Effect.succeed<BaseBranchSquash>("unreadable"),
			}),
		),
);

const readSignals = Effect.fn("Github.signals")(function* (repo: string, pr: number) {
	const prState = yield* readPrState(repo, pr);
	const lastEvent = yield* readLastMergeQueueEvent(repo, pr);
	// Not read once the PR itself reads merged: the cross-check exists to correct a stale
	// not-merged read, so there is nothing left for it to corroborate.
	const baseBranchSquash = prState.merged
		? undefined
		: yield* readBaseBranchSquash(repo, pr, prState.baseRefName);
	return {
		merged: prState.merged,
		state: prState.state,
		lastMergeQueueEvent: lastEvent,
		mergeStateStatus: prState.mergeStateStatus,
		baseBranchSquash,
	} satisfies MergeQueueSignals;
});

/**
 * `Github` — the IO shell over `gh` REST for the reconcile's ground-truth reads. `signals(pr,
 * repoOverride?)` resolves the full `MergeQueueSignals` the pure `classify` consumes; a non-empty
 * `repoOverride` (the CLI `--repo` flag, ADR 0062 §1's highest precedence) wins over the resolved
 * repo, else the repo is resolved once (`RepoResolutionError`). An unreadable PR state propagates
 * typed (the command maps it to `pending`); an unreadable timeline is recovered to the settle
 * window, and an unreadable base branch to `unreadable`. Built by `GithubLive`, whose `R` is
 * `ChildProcessSpawner`.
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
