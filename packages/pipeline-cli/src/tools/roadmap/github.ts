/**
 * The GitHub boundary for `roadmap view`: the live `Github` capability that gathers the
 * read-only projection — milestones, open issues (+ each epic's sub-issue children), and open
 * PRs — over `gh api` REST, so the IO-free `roadmap.ts` core can assemble the tree. Same service
 * pattern as `roadmap-guard`'s `Milestones` / `campaign`'s `Github` (epic #994): a
 * `Context.Service` on `ChildProcessSpawner`, REST only (GraphQL is broken on the kamp-us org),
 * every infra failure a typed error in the `E` channel, untrusted REST JSON Schema-decoded at the
 * boundary into the domain shapes the core resolves over.
 *
 * READ-ONLY by construction: every `gh api` call here is a GET; the view mutates no labels,
 * milestones, or issues/PRs (the AC's read-only invariant, #2651).
 */
import {Context, Effect, Layer, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {
	type Issue,
	isEpic,
	type Milestone,
	type PullRequest,
	parseLinkedIssues,
	priorityOf,
	type RoadmapFacts,
} from "./roadmap.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/roadmap/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/roadmap/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/roadmap/RepoResolutionError",
	{
		message: Schema.String,
	},
) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

/**
 * Run `gh <args>` and return stdout, failing `GhCommandError` on a non-zero exit — the same
 * direct-spawn shape `roadmap-guard`/`campaign` use so a non-zero exit + stderr lower into a typed
 * error rather than a throw. A spawn/IO `PlatformError` (e.g. `gh` not on PATH) folds in as exit `-1`.
 */
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

const json = Effect.fn("Github.json")(function* (args: ReadonlyArray<string>) {
	const raw = yield* runGh(args);
	return yield* Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the target repo (`owner/name`) once, per ADR 0062 §1, in order:
 * `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` (CI) → `gh repo view`. Never silently defaults —
 * with no env and no resolvable current repo it fails `RepoResolutionError`.
 */
const resolveRepo = Effect.fn("Github.resolveRepo")(function* () {
	const fromEnv = process.env.CLAUDE_PIPELINE_REPO ?? process.env.GITHUB_REPOSITORY;
	if (fromEnv && REPO_RE.test(fromEnv.trim())) {
		return fromEnv.trim();
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
		Effect.catchTag("@kampus/roadmap/GhCommandError", () => Effect.succeed("")),
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

// `state=all` so I can resolve a done arc's CLOSED milestone by number; `--paginate` for >100.
const milestonesArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/milestones`,
	"-f",
	"state=all",
	"-f",
	"per_page=100",
	"--paginate",
];

// Open issues only — the tree renders live open work; sub-issue children (which may be closed)
// are gathered per-epic below. PRs come back on this endpoint too and are filtered out.
const openIssuesArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/issues`,
	"-f",
	"state=open",
	"-f",
	"per_page=100",
	"--paginate",
];

const subIssuesArgs = (repo: string, epic: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	`repos/${repo}/issues/${epic}/sub_issues?per_page=100`,
];

const openPullsArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"-X",
	"GET",
	`repos/${repo}/pulls`,
	"-f",
	"state=open",
	"-f",
	"per_page=100",
	"--paginate",
];

// --- boundary decoders -----------------------------------------------------------

/** A raw issue as the issues endpoint returns it; `pull_request` present ⇒ it's a PR, filtered out. */
const RawIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	state: Schema.Literals(["open", "closed"]),
	labels: Schema.Array(Schema.Struct({name: Schema.String})),
	milestone: Schema.NullOr(Schema.Struct({number: Schema.Number})),
	pull_request: Schema.optionalKey(Schema.Unknown),
});
const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(RawIssue));

/** A raw sub-issue as the sub_issues endpoint returns it — the epic's children. */
const RawSubIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	state: Schema.Literals(["open", "closed"]),
	labels: Schema.Array(Schema.Struct({name: Schema.String})),
	milestone: Schema.NullOr(Schema.Struct({number: Schema.Number})),
});
const decodeSubIssues = Schema.decodeUnknownEffect(Schema.Array(RawSubIssue));

const RawMilestone = Schema.Struct({
	number: Schema.Number,
	state: Schema.Literals(["open", "closed"]),
	title: Schema.String,
});
const decodeMilestones = Schema.decodeUnknownEffect(Schema.Array(RawMilestone));

const RawPull = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	body: Schema.NullOr(Schema.String),
	head: Schema.Struct({ref: Schema.String}),
});
const decodePulls = Schema.decodeUnknownEffect(Schema.Array(RawPull));

// --- IO operations ---------------------------------------------------------------

const toIssue = (
	raw: {
		readonly number: number;
		readonly title: string;
		readonly state: "open" | "closed";
		readonly labels: ReadonlyArray<{readonly name: string}>;
		readonly milestone: {readonly number: number} | null;
	},
	parent: number | null,
): Issue => {
	const labels = raw.labels.map((l) => l.name);
	return {
		number: raw.number,
		title: raw.title,
		state: raw.state,
		labels,
		milestone: raw.milestone?.number ?? null,
		parent,
		isEpic: isEpic(labels),
		priority: priorityOf(labels),
	};
};

const listMilestones = Effect.fn("Github.milestones")(function* (repo: string) {
	const raw = yield* decodeMilestones(yield* json(milestonesArgs(repo)));
	return raw.map((m): Milestone => ({number: m.number, state: m.state, title: m.title}));
});

const listOpenIssues = Effect.fn("Github.openIssues")(function* (repo: string) {
	const raw = yield* decodeIssues(yield* json(openIssuesArgs(repo)));
	return raw.filter((r) => r.pull_request === undefined).map((r) => toIssue(r, null));
});

const listSubIssues = Effect.fn("Github.subIssues")(function* (repo: string, epic: number) {
	const raw = yield* decodeSubIssues(yield* json(subIssuesArgs(repo, epic)));
	return raw.map((r) => toIssue(r, epic));
});

const listOpenPulls = Effect.fn("Github.openPulls")(function* (repo: string) {
	const raw = yield* decodePulls(yield* json(openPullsArgs(repo)));
	return raw.map(
		(p): PullRequest => ({
			number: p.number,
			title: p.title,
			branch: p.head.ref,
			linkedIssues: parseLinkedIssues(p.body ?? "", p.head.ref),
		}),
	);
});

/**
 * Gather the whole read-only projection. Open issues are fetched once; each epic among them then
 * has its sub-issue children fetched (bounded by the epic count) and merged in with `parent` set —
 * children the open-issues page may already carry are de-duped by number so no issue doubles up.
 */
const gather = Effect.fn("Github.gather")(function* (repo: string) {
	const [milestones, openIssues, pulls] = yield* Effect.all(
		[listMilestones(repo), listOpenIssues(repo), listOpenPulls(repo)],
		{concurrency: "unbounded"},
	);
	const epics = openIssues.filter((i) => i.isEpic);
	const childLists = yield* Effect.forEach(epics, (e) => listSubIssues(repo, e.number), {
		concurrency: "unbounded",
	});
	const byNumber = new Map<number, Issue>();
	for (const i of openIssues) byNumber.set(i.number, i);
	// A child fetched via sub_issues carries the authoritative parent pin; let it win over the
	// same issue seen parent-less on the open-issues page (de-dupe, parent-aware).
	for (const child of childLists.flat()) byNumber.set(child.number, child);
	return {milestones, issues: [...byNumber.values()], pulls} satisfies RoadmapFacts;
});

/**
 * `Github` — the IO shell over `gh api` REST for `roadmap view`. `gather` reads the milestone /
 * issue / epic-child / open-PR projection. Built by `GithubLive`, whose `R` is `ChildProcessSpawner`.
 */
export class Github extends Context.Service<
	Github,
	{
		readonly gather: () => Effect.Effect<
			RoadmapFacts,
			RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError
		>;
	}
>()("@kampus/roadmap/Github") {}

/**
 * The live `Github` layer. The `ChildProcessSpawner` dependency is captured once at construction
 * and provided into each method body, so the public method carries `R = never`. Repo resolution is
 * deferred to first use (`Effect.cached`, ADR 0062 §1): the layer build is side-effect-free, and
 * `RepoResolutionError` lives in the method's `E` channel, raised only when `gather` actually reads.
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
				gather: () => repo.pipe(Effect.flatMap((r) => withSpawner(gather(r)))),
			};
		}),
	);
