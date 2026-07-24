/**
 * The GitHub boundary for `merge-intent`: the live `Github` capability that reads the merge
 * state ADR 0198's decision runs on, and performs the disarm **with a read-back verify**.
 *
 * Same service pattern as `merge-queue-classify/github.ts` / `verdict/github.ts`: a
 * `Context.Service` on `ChildProcessSpawner` (`.patterns/effect-process-cli-shell.md`), `gh` REST
 * (plus the `gh pr merge` porcelain the merge itself uses — never GraphQL queries, which the org's
 * Projects-classic integration breaks), every infra failure a typed error in the `E` channel, and
 * the untrusted `gh` JSON `Schema`-decoded at the boundary.
 *
 * The read-back verify is the point: `gh pr merge --disable-auto` exits non-zero both when the
 * disable genuinely failed and when there was simply nothing armed, so its exit code cannot carry
 * the guarantee. Re-reading `auto_merge` can — the claim this tool makes is "**the PR carries no
 * armed auto-merge request**", asserted against live state after the attempt, the same
 * self-verify shape `verdict post` applies to a landed comment (#3019).
 */
import {Config, Context, Effect, Layer, Option, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {lastMergeQueueEvent} from "../merge-queue-classify/merge-queue-classify.ts";
import type {MergeIntentState} from "./merge-intent.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/merge-intent/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the reader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/merge-intent/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/merge-intent/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/** The raw result of a `gh` run — kept whole so a tolerated non-zero exit is still reportable. */
interface GhResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

// See `merge-queue-classify/github.ts` `runGh`: spawn the handle directly (not
// `ChildProcessSpawner.string`, which hides the exit code) and fold a spawn `PlatformError`
// (e.g. `gh` off PATH) into the same shape at exit `-1`, so the `E` channel never carries a throw.
const runGhRaw = Effect.fn("Github.runGhRaw")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("gh", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{concurrency: "unbounded"},
		);
		return {stdout, stderr, exitCode} satisfies GhResult;
	},
	Effect.scoped,
	(effect) =>
		Effect.catchTag(effect, "PlatformError", (cause) =>
			Effect.succeed({stdout: "", stderr: cause.message, exitCode: -1} satisfies GhResult),
		),
);

/** `runGhRaw` with a non-zero exit lowered into the typed `E` channel — the reads' shape. */
const runGh = Effect.fn("Github.runGh")(function* (args: ReadonlyArray<string>) {
	const result = yield* runGhRaw(args);
	if (result.exitCode !== 0) {
		return yield* new GhCommandError({args, exitCode: result.exitCode, stderr: result.stderr});
	}
	return result.stdout;
});

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

/** The env half of repo resolution (ADR 0062 §1), read via `Config` rather than `process.env`. */
const repoFromEnv = Config.string("CLAUDE_PIPELINE_REPO").pipe(
	Config.orElse(() => Config.string("GITHUB_REPOSITORY")),
	Config.option,
);

/**
 * Resolve the target repo (`owner/name`), per ADR 0062 §1: `CLAUDE_PIPELINE_REPO` →
 * `GITHUB_REPOSITORY` → `gh repo view`. Never silently defaults — with no env and no resolvable
 * current repo it fails `RepoResolutionError`, which the bin surfaces as a LOUD failure: a run
 * that cannot address the PR cannot assert that no intent is armed on it.
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
		Effect.catchTag("@kampus/merge-intent/GhCommandError", () => Effect.succeed("")),
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
 * The PR resource: `merged`, whether an auto-merge request is armed (`auto_merge != null`), and the
 * base branch — the branch whose queue regime rule 4's exemption is about.
 */
const prArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/pulls/${pr}`,
	"--jq",
	"{merged: (.merged == true), armed: (.auto_merge != null), base: .base.ref}",
];

/**
 * The rules that apply to a branch, across every active ruleset. A `merge_queue` rule in the
 * response is the authoritative "this branch is queue-governed" signal — the repo/branch-level
 * property rule 4 keys on. (Classic branch protection carries no merge-queue field, and on a
 * ruleset-governed repo `branches/<b>/protection` 404s, so this is the endpoint that answers it;
 * verified live against `kamp-us/phoenix` `main`, which returns a `merge_queue` rule.)
 */
const branchRulesArgs = (repo: string, branch: string): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
];

/** The REST issue-timeline endpoint — the authoritative merge-queue-membership signal. */
const timelineArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/issues/${pr}/timeline?per_page=100`,
	"--paginate",
];

/** `gh pr merge --disable-auto` — the porcelain that clears an armed merge request. */
const disableArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"pr",
	"merge",
	String(pr),
	"--repo",
	repo,
	"--disable-auto",
];

const RawPr = Schema.Struct({
	merged: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	armed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	base: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodePr = Schema.decodeUnknownEffect(RawPr);

const RawRule = Schema.Struct({type: Schema.optionalKey(Schema.NullOr(Schema.String))});
const decodeRules = Schema.decodeUnknownEffect(Schema.Array(RawRule));

const RawTimelineEntry = Schema.Struct({
	event: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeTimeline = Schema.decodeUnknownEffect(Schema.Array(RawTimelineEntry));

/**
 * The `merged` + `armed` + base-branch half of the state, recovered to the fail-closed unknown on
 * any fault (a `null` base then denies the regime probe its input — see `readQueueGoverned`).
 */
const readPr = Effect.fn("Github.readPr")(
	function* (repo: string, pr: number) {
		const args = prArgs(repo, pr);
		const raw = yield* decodePr(yield* parseJson(args, yield* runGh(args)));
		return {
			merged: raw.merged === true,
			armed: (raw.armed ?? false) as boolean | "unknown",
			base: raw.base ?? null,
		};
	},
	(effect) =>
		effect.pipe(
			Effect.catchTags({
				"@kampus/merge-intent/GhCommandError": () =>
					Effect.succeed({merged: false, armed: "unknown" as const, base: null}),
				"@kampus/merge-intent/GhParseError": () =>
					Effect.succeed({merged: false, armed: "unknown" as const, base: null}),
				SchemaError: () => Effect.succeed({merged: false, armed: "unknown" as const, base: null}),
			}),
		),
);

/**
 * Is the PR queued *now*? Last event wins — the resolution `merge-queue-classify` owns, imported
 * rather than re-derived. An unreadable timeline recovers to "not queued": the decision then rests
 * on `armed`, which already reads `null` — i.e. `keep` at rule 3 — for a PR sitting in the queue,
 * so a timeline fault cannot dequeue a live entry.
 */
const readQueued = Effect.fn("Github.readQueued")(
	function* (repo: string, pr: number) {
		const args = timelineArgs(repo, pr);
		// `--paginate` concatenates JSON arrays; normalize `][` joins into one array before parsing.
		const merged = (yield* runGh(args)).replace(/\]\s*\[/g, ",");
		const entries = yield* decodeTimeline(yield* parseJson(args, merged));
		const projected = entries.map((e) => {
			const entry: {event?: string; created_at?: string} = {};
			if (e.event != null) entry.event = e.event;
			if (e.created_at != null) entry.created_at = e.created_at;
			return entry;
		});
		return lastMergeQueueEvent(projected) === "added_to_merge_queue";
	},
	(effect) =>
		effect.pipe(
			Effect.catchTags({
				"@kampus/merge-intent/GhCommandError": () => Effect.succeed(false),
				"@kampus/merge-intent/GhParseError": () => Effect.succeed(false),
				SchemaError: () => Effect.succeed(false),
			}),
		),
);

/**
 * Is the base branch governed by a merge queue? Every fault — an unknown base, a `gh` failure, an
 * undecodable body — resolves **`true`**, because `false` is the sole trigger of rule 4's keep: a
 * read this run could not make must never be the thing that lets an intent stay parked.
 */
const readQueueGoverned = Effect.fn("Github.readQueueGoverned")(
	function* (repo: string, base: string | null) {
		if (base === null || base.trim() === "") return true;
		const args = branchRulesArgs(repo, base.trim());
		const rules = yield* decodeRules(yield* parseJson(args, yield* runGh(args)));
		return rules.some((r) => r.type === "merge_queue");
	},
	(effect) =>
		effect.pipe(
			Effect.catchTags({
				"@kampus/merge-intent/GhCommandError": () => Effect.succeed(true),
				"@kampus/merge-intent/GhParseError": () => Effect.succeed(true),
				SchemaError: () => Effect.succeed(true),
			}),
		),
);

const readState = Effect.fn("Github.state")(function* (repo: string, pr: number) {
	const pull = yield* readPr(repo, pr);
	const queued = yield* readQueued(repo, pr);
	const queueGoverned = yield* readQueueGoverned(repo, pull.base);
	return {
		merged: pull.merged,
		armed: pull.armed,
		queued,
		queueGoverned,
	} satisfies MergeIntentState;
});

/** The verified outcome of a disarm attempt. */
export interface DisarmOutcome {
	/** Live `auto_merge == null` confirmed by the post-attempt read-back — the whole guarantee. */
	readonly cleared: boolean;
	/** The `gh pr merge --disable-auto` exit code; non-zero is tolerated when the read-back is clean. */
	readonly exitCode: number;
	/** `gh`'s stderr, carried so a genuine failure is legible in the run log. */
	readonly stderr: string;
}

const disarmIntent = Effect.fn("Github.disarm")(function* (repo: string, pr: number) {
	const attempt = yield* runGhRaw(disableArgs(repo, pr));
	const after = yield* readPr(repo, pr);
	return {
		cleared: after.armed === false,
		exitCode: attempt.exitCode,
		stderr: attempt.stderr.trim(),
	} satisfies DisarmOutcome;
});

/**
 * `Github` — the IO shell over `gh` for the merge-intent lifecycle. `state(pr)` resolves the
 * `MergeIntentState` the pure `decideMergeIntent` consumes; `disarm(pr)` clears the armed request
 * and verifies the clear by re-reading `auto_merge`. A non-empty `repoOverride` (the `--repo`
 * flag, ADR 0062 §1's highest precedence) wins over the resolved repo.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly state: (
			pr: number,
			repoOverride?: string,
		) => Effect.Effect<MergeIntentState, RepoResolutionError>;
		readonly disarm: (
			pr: number,
			repoOverride?: string,
		) => Effect.Effect<DisarmOutcome, RepoResolutionError>;
	}
>()("@kampus/merge-intent/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at construction
 * and provided into each method body, so the public methods carry `R = never`. Repo resolution is
 * deferred to first use (`Effect.cached`, ADR 0062 §1) and shared by both methods, so a `state` +
 * `disarm` pair in one run resolves the repo once.
 */
export const GithubLive: Layer.Layer<Github, never, ChildProcessSpawner.ChildProcessSpawner> =
	Layer.effect(Github)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			const target = (repoOverride?: string) =>
				repoOverride !== undefined && repoOverride.trim() !== ""
					? Effect.succeed(repoOverride.trim())
					: repo;
			return {
				state: (pr, repoOverride) =>
					target(repoOverride).pipe(Effect.flatMap((r) => withSpawner(readState(r, pr)))),
				disarm: (pr, repoOverride) =>
					target(repoOverride).pipe(Effect.flatMap((r) => withSpawner(disarmIntent(r, pr)))),
			};
		}),
	);
