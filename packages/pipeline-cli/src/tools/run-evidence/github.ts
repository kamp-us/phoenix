/**
 * The `gh api` REST boundary for `run-evidence read`: resolve a PR's head SHA, find the producer
 * run at that EXACT head, list its artifacts, download the archive, and read `manifest.json` out of
 * it — handing the pure classifier one `Observation` (`run-evidence.ts`).
 *
 * Same service shape as `leak-guard`'s `PrComments` / `checks`'s `Github` (a `Context.Service` on
 * `ChildProcessSpawner`, repo resolved once per ADR 0062 §1, REST only — GraphQL is broken on the
 * kamp-us org, untrusted REST JSON Schema-decoded at the boundary).
 *
 * Two boundary rules this tool exists to hold, both of which a hand-rolled `gh` snippet got wrong:
 *
 *  - **A read that fails is UNKNOWN, never absence.** Every leg captures its cause and converts to
 *    an `*Unreadable` observation; nothing here can hand the classifier an empty value that reads as
 *    "the producer published nothing" (#3991). Transient 5xx/429/transport faults are retried with
 *    bounded backoff first — the same transient class `leak-guard`'s `isTransientGh` owns.
 *  - **Never `gh api --silent`.** `--silent` discards the response body, so an artifact download
 *    "succeeds" with zero bytes and the missing manifest reads as a missing bundle. The arg builders
 *    below are exported so that invariant is asserted by a test, not by reviewer vigilance.
 */
import {Context, Effect, Layer, Schedule, Stream} from "effect";
import * as Schema from "effect/Schema";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {Manifest} from "../crabbox-manifest/Manifest.ts";
import {
	MANIFEST_ENTRY,
	type ManifestSummary,
	type Observation,
	PRODUCER_NAME,
	type Probe,
	type ProducerRun,
	resolveProducerRun,
} from "./run-evidence.ts";
import {readZipEntry} from "./zip.ts";

/** A `gh` invocation exited non-zero (auth, not-found, rate-limit, 5xx …). */
export class GhCommandError extends Schema.TaggedErrorClass<GhCommandError>()(
	"@kampus/run-evidence/GhCommandError",
	{
		args: Schema.Array(Schema.String),
		exitCode: Schema.Number,
		stderr: Schema.String,
	},
) {}

/** `gh` output was not the JSON the loader expected. */
export class GhParseError extends Schema.TaggedErrorClass<GhParseError>()(
	"@kampus/run-evidence/GhParseError",
	{
		args: Schema.Array(Schema.String),
		message: Schema.String,
	},
) {}

/** No `owner/name` target repo could be resolved (no env override, no current repo). */
export class RepoResolutionError extends Schema.TaggedErrorClass<RepoResolutionError>()(
	"@kampus/run-evidence/RepoResolutionError",
	{message: Schema.String},
) {}

// The transient class worth retrying: the 5xx gateway/overload family plus 429. Everything else —
// 401/403/404/422 — is a real terminal answer and fails fast, so an auth/not-found error is never
// masked as a blip. Kept identical to leak-guard's `isTransientGh` (#3710).
const TRANSIENT_HTTP_STATUS_RE = /\bHTTP\s+(429|5\d\d)\b/i;
const TRANSIENT_TRANSPORT_RE =
	/\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|connection reset|connection refused|timed?\s*out|TLS handshake|i\/o timeout|network is unreachable|temporary failure|EOF occurred)\b/i;

/** Is this `gh` failure a transient transport/availability blip (retry) or a terminal answer? */
export const isTransientGh = (error: GhCommandError): boolean =>
	error.exitCode === -1 ||
	TRANSIENT_HTTP_STATUS_RE.test(error.stderr) ||
	TRANSIENT_TRANSPORT_RE.test(error.stderr);

const collectText = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string> =>
	Stream.decodeText(stream).pipe(
		Stream.mkString,
		Effect.orElseSucceed(() => ""),
	);

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
};

const collectBytes = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<Uint8Array> =>
	Stream.runCollect(stream).pipe(
		Effect.map(concatBytes),
		Effect.orElseSucceed(() => new Uint8Array(0)),
	);

/** Spawn `gh`, returning stdout as raw bytes — the artifact archive is binary, so never as text. */
const runGhBytes = Effect.fn("RunEvidence.runGhBytes")(
	function* (args: ReadonlyArray<string>) {
		const handle = yield* ChildProcess.make("gh", args);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collectBytes(handle.stdout), collectText(handle.stderr), handle.exitCode],
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

const runGh = (
	args: ReadonlyArray<string>,
): Effect.Effect<string, GhCommandError, ChildProcessSpawner.ChildProcessSpawner> =>
	runGhBytes(args).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)));

const json = Effect.fn("RunEvidence.json")(function* (args: ReadonlyArray<string>) {
	const raw = yield* runGh(args);
	return yield* Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new GhParseError({args, message: cause instanceof Error ? cause.message : String(cause)}),
	});
});

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/** Resolve the target repo (`owner/name`) per ADR 0062 §1: env override → CI env → `gh repo view`. */
const resolveRepo = Effect.fn("RunEvidence.resolveRepo")(function* () {
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
		Effect.catchTag("@kampus/run-evidence/GhCommandError", () => Effect.succeed("")),
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

/** The PR whose live head the bundle must be bound to. */
export const prArgs = (repo: string, pr: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/pulls/${pr}`,
];

/** Does this repo define the producer at all? An adopter without it has no bundle to miss (ADR 0086). */
export const workflowsArgs = (repo: string): ReadonlyArray<string> => [
	"api",
	"--paginate",
	"--slurp",
	`repos/${repo}/actions/workflows?per_page=100`,
];

/** Producer runs keyed on the EXACT head SHA — the binding filter (ADR 0056 §2). */
export const runsAtHeadArgs = (repo: string, sha: string): ReadonlyArray<string> => [
	"api",
	"--paginate",
	"--slurp",
	`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
];

export const artifactsArgs = (repo: string, runId: number): ReadonlyArray<string> => [
	"api",
	"--paginate",
	"--slurp",
	`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
];

export const artifactZipArgs = (repo: string, artifactId: number): ReadonlyArray<string> => [
	"api",
	`repos/${repo}/actions/artifacts/${artifactId}/zip`,
];

/** Every `gh` arg list this boundary builds — the surface the no-`--silent` invariant is asserted over. */
export const allArgBuilders = (repo: string): ReadonlyArray<ReadonlyArray<string>> => [
	prArgs(repo, 1),
	workflowsArgs(repo),
	runsAtHeadArgs(repo, "deadbeef"),
	artifactsArgs(repo, 1),
	artifactZipArgs(repo, 1),
];

const RawPr = Schema.Struct({head: Schema.Struct({sha: Schema.String})});
const decodePr = Schema.decodeUnknownEffect(RawPr);

const RawWorkflowPages = Schema.Array(
	Schema.Struct({workflows: Schema.Array(Schema.Struct({name: Schema.String}))}),
);
const decodeWorkflowPages = Schema.decodeUnknownEffect(RawWorkflowPages);

const RawRunPages = Schema.Array(
	Schema.Struct({
		workflow_runs: Schema.Array(
			Schema.Struct({
				id: Schema.Number,
				name: Schema.NullOr(Schema.String),
				head_sha: Schema.String,
				status: Schema.NullOr(Schema.String),
				conclusion: Schema.NullOr(Schema.String),
				created_at: Schema.String,
			}),
		),
	}),
);
const decodeRunPages = Schema.decodeUnknownEffect(RawRunPages);

const RawArtifactPages = Schema.Array(
	Schema.Struct({
		artifacts: Schema.Array(
			Schema.Struct({
				id: Schema.Number,
				name: Schema.String,
				expired: Schema.optionalKey(Schema.Boolean),
			}),
		),
	}),
);
const decodeArtifactPages = Schema.decodeUnknownEffect(RawArtifactPages);

const decodeManifest = Schema.decodeUnknownEffect(Manifest);

type LegError = GhCommandError | GhParseError | Schema.SchemaError;

/**
 * One read leg as a SINGLE effect: fetch, parse, decode. Composed rather than `yield*`-ed
 * step-by-step on purpose — a `yield*` inside the retry/catch wrapper escapes it, and an escaped
 * fault is exactly the silent path this tool exists to close.
 */
const readDecoded = <A>(
	args: ReadonlyArray<string>,
	decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
): Effect.Effect<A, LegError, ChildProcessSpawner.ChildProcessSpawner> =>
	json(args).pipe(Effect.flatMap(decode));

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim().slice(0, 200);

/** Render a leg failure as the one-line cause an UNKNOWN reading carries into the verdict. */
const describeLegError = (error: LegError): string => {
	if (error._tag === "@kampus/run-evidence/GhCommandError") {
		return `gh exited ${error.exitCode} — ${firstLine(error.stderr) || "no stderr captured"}`;
	}
	if (error._tag === "@kampus/run-evidence/GhParseError") {
		return `response was not JSON — ${firstLine(error.message)}`;
	}
	return `response did not conform to the expected shape — ${firstLine(String(error))}`;
};

type Attempt<A> =
	| {readonly ok: true; readonly value: A}
	| {readonly ok: false; readonly cause: string};

// Bounded exponential backoff (~0.5s, 1, 2, 4s over 4 retries) — enough to ride out a GH 5xx blip
// without holding a review open through a sustained outage. Same idiom/budget as leak-guard's read.
const MAX_RETRIES = 4;
const DEFAULT_RETRY_SCHEDULE = Schedule.both(
	Schedule.exponential("500 millis"),
	Schedule.recurs(MAX_RETRIES),
);

const isTransientLeg = (error: LegError): error is GhCommandError =>
	error._tag === "@kampus/run-evidence/GhCommandError" && isTransientGh(error);

const attempt = <A>(
	effect: Effect.Effect<A, LegError, ChildProcessSpawner.ChildProcessSpawner>,
	retrySchedule: Schedule.Schedule<unknown, unknown>,
): Effect.Effect<Attempt<A>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	effect.pipe(
		Effect.retry({schedule: retrySchedule, while: isTransientLeg}),
		Effect.map((value): Attempt<A> => ({ok: true, value})),
		Effect.catch((error: LegError) =>
			Effect.succeed<Attempt<A>>({ok: false, cause: describeLegError(error)}),
		),
	);

const summarize = (manifest: Manifest): ManifestSummary => ({
	commit: manifest.commit,
	schemaVersion: manifest.schemaVersion,
	checks: manifest.checks.map((check) => ({name: check.name, status: check.status})),
	tests: {
		total: manifest.tests.total,
		passed: manifest.tests.passed,
		failed: manifest.tests.failed,
		skipped: manifest.tests.skipped,
		failingSuites: manifest.tests.failures.map((failure) => `${failure.suite} › ${failure.name}`),
	},
});

const headSha = Effect.fn("RunEvidence.headSha")(function* (repo: string, pr: number) {
	const args = prArgs(repo, pr);
	return (yield* decodePr(yield* json(args))).head.sha;
});

/**
 * Walk the lookup to exactly one `Observation`. Ordered so that an unreadable step never falls
 * through into a step whose empty result would look like absence.
 */
const probe = Effect.fn("RunEvidence.probe")(function* (
	repo: string,
	sha: string,
	retrySchedule: Schedule.Schedule<unknown, unknown>,
) {
	const observed = (observation: Observation, runsAtHead: number | null = null): Probe => ({
		queriedSha: sha,
		runsAtHead,
		observation,
	});

	const workflows = yield* attempt(
		readDecoded(workflowsArgs(repo), decodeWorkflowPages),
		retrySchedule,
	);
	if (!workflows.ok) {
		return observed({_tag: "ProducerUnreadable", cause: workflows.cause});
	}
	const producerDefined = workflows.value.some((page) =>
		page.workflows.some((workflow) => workflow.name === PRODUCER_NAME),
	);
	if (!producerDefined) {
		return observed({_tag: "ProducerWorkflowAbsent"});
	}

	const runs = yield* attempt(
		readDecoded(runsAtHeadArgs(repo, sha), decodeRunPages),
		retrySchedule,
	);
	if (!runs.ok) {
		return observed({_tag: "RunsUnreadable", cause: runs.cause});
	}
	const producerRuns: ReadonlyArray<ProducerRun> = runs.value
		.flatMap((page) => page.workflow_runs)
		.filter((run) => run.name === PRODUCER_NAME)
		.map((run) => ({
			id: run.id,
			headSha: run.head_sha,
			status: run.status ?? "unknown",
			conclusion: run.conclusion,
			createdAt: run.created_at,
		}));
	const atHead = producerRuns.filter((run) => run.headSha === sha).length;
	const run = resolveProducerRun(producerRuns, sha);
	if (run === null) {
		return observed({_tag: "NoRunAtHead"}, 0);
	}
	if (run.status !== "completed") {
		return observed({_tag: "RunNotCompleted", run}, atHead);
	}

	const artifacts = yield* attempt(
		readDecoded(artifactsArgs(repo, run.id), decodeArtifactPages),
		retrySchedule,
	);
	if (!artifacts.ok) {
		return observed({_tag: "ArtifactsUnreadable", run, cause: artifacts.cause}, atHead);
	}
	const artifact = artifacts.value
		.flatMap((page) => page.artifacts)
		.find((candidate) => candidate.name === PRODUCER_NAME);
	if (artifact === undefined) {
		return observed({_tag: "ArtifactMissing", run}, atHead);
	}
	if (artifact.expired === true) {
		return observed({_tag: "ArtifactExpired", run, artifactId: artifact.id}, atHead);
	}

	const download = yield* attempt(runGhBytes(artifactZipArgs(repo, artifact.id)), retrySchedule);
	if (!download.ok) {
		return observed(
			{_tag: "DownloadUnreadable", run, artifactId: artifact.id, cause: download.cause},
			atHead,
		);
	}
	const entry = readZipEntry(download.value, MANIFEST_ENTRY);
	if (entry._tag === "Malformed") {
		return observed(
			{_tag: "ArchiveUnreadable", run, artifactId: artifact.id, cause: entry.reason},
			atHead,
		);
	}
	if (entry._tag === "NotFound") {
		return observed(
			{
				_tag: "ArchiveUnreadable",
				run,
				artifactId: artifact.id,
				cause: `no \`${MANIFEST_ENTRY}\` in the archive (entries: ${entry.names.join(", ") || "none"})`,
			},
			atHead,
		);
	}
	const decoded = yield* attempt(
		Effect.try({
			try: () => JSON.parse(new TextDecoder().decode(entry.bytes)) as unknown,
			catch: (cause) =>
				new GhParseError({
					args: artifactZipArgs(repo, artifact.id),
					message: cause instanceof Error ? cause.message : String(cause),
				}),
		}).pipe(Effect.flatMap(decodeManifest)),
		retrySchedule,
	);
	if (!decoded.ok) {
		return observed(
			{_tag: "ManifestUnreadable", run, artifactId: artifact.id, cause: decoded.cause},
			atHead,
		);
	}
	return observed(
		{
			_tag: "ManifestRead",
			run,
			artifactId: artifact.id,
			manifest: summarize(decoded.value),
		},
		atHead,
	);
});

type GhError = RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError;

/**
 * `RunEvidenceIo` — the IO shell over `gh api` REST. `probe` carries no failure channel beyond repo
 * resolution: every read fault is folded into an `*Unreadable` observation so the classifier, not
 * an exception path, decides the state.
 */
export class RunEvidenceIo extends Context.Service<
	RunEvidenceIo,
	{
		readonly headSha: (pr: number) => Effect.Effect<string, GhError>;
		readonly probe: (sha: string) => Effect.Effect<Probe, RepoResolutionError>;
	}
>()("@kampus/run-evidence/RunEvidenceIo") {}

/**
 * The layer, parameterized by its retry schedule so a unit test can inject a zero-delay budget.
 * Repo resolution is deferred to first use (`Effect.cached`, ADR 0062 §1) — the build is
 * side-effect-free.
 */
export const makeRunEvidenceIoLive = (
	retrySchedule: Schedule.Schedule<unknown, unknown> = DEFAULT_RETRY_SCHEDULE,
): Layer.Layer<RunEvidenceIo, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.effect(RunEvidenceIo)(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const withSpawner = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) => effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
			const repo = yield* Effect.cached(withSpawner(resolveRepo()));
			return {
				headSha: (pr) => repo.pipe(Effect.flatMap((r) => withSpawner(headSha(r, pr)))),
				probe: (sha) => repo.pipe(Effect.flatMap((r) => withSpawner(probe(r, sha, retrySchedule)))),
			};
		}),
	);

/** The production layer — the bounded-backoff retry over the real `gh` boundary. */
export const RunEvidenceIoLive: Layer.Layer<
	RunEvidenceIo,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = makeRunEvidenceIoLive();
