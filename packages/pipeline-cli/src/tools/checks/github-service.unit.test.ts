import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {Github, GithubLive, type RepoResolutionError} from "./github.ts";

const PINNED_REPO = "kamp-us/phoenix";
let savedEnv: string | undefined;
beforeAll(() => {
	savedEnv = process.env.CLAUDE_PIPELINE_REPO;
	process.env.CLAUDE_PIPELINE_REPO = PINNED_REPO;
});
afterAll(() => {
	if (savedEnv === undefined) delete process.env.CLAUDE_PIPELINE_REPO;
	else process.env.CLAUDE_PIPELINE_REPO = savedEnv;
});

const enc = new TextEncoder();

/** A `ChildProcessSpawner` answering `gh api` from a REST-path fixture map. */
const mockSpawner = (
	responses: Record<string, string>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const path = (args.find((a) => a.startsWith("repos/")) ?? "").replace(/\?.*$/, "");
				const found = path in responses;
				const stdout = found ? responses[path]! : "";
				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(1),
					stdin: Sink.drain,
					stdout: Stream.fromIterable([enc.encode(stdout)]),
					stderr: Stream.fromIterable([
						enc.encode(found ? "" : `gh: Not Found (HTTP 404) ${path}`),
					]),
					all: Stream.fromIterable([enc.encode(stdout)]),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(found ? 0 : 1)),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
			}),
		),
	);

const provide = <A, E>(
	effect: Effect.Effect<A, E, Github>,
	responses: Record<string, string>,
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(Effect.provide(GithubLive.pipe(Layer.provide(mockSpawner(responses)))));

const SHA = "bb21a70f0000000000000000000000000000dead";
const checkRunsPath = `repos/${PINNED_REPO}/commits/${SHA}/check-runs`;
const checkSuitesPath = `repos/${PINNED_REPO}/commits/${SHA}/check-suites`;
const statusPath = `repos/${PINNED_REPO}/commits/${SHA}/status`;
const noStatuses = JSON.stringify({state: "pending", total_count: 0});

const checkRun = (over: {
	readonly name: string;
	readonly conclusion: string | null;
	readonly started_at: string;
	readonly id: number;
}) => ({completed_at: over.started_at, ...over});

/** `gh api --paginate --slurp` hands back one envelope per page — the shape the shell decodes. */
const pages = (...perPage: ReadonlyArray<ReadonlyArray<unknown>>) =>
	JSON.stringify(perPage.map((check_runs) => ({total_count: 0, check_runs})));

describe("Github.read — the fetched head rolls up latest-per-context", () => {
	// The #3762 reproduction, through the real decode path: the endpoint hands back every run
	// for the SHA, superseded ones included, and only the latest per context may decide.
	it.effect("superseded reds do not red a head whose latest runs are green", () =>
		Effect.gen(function* () {
			const rollup = yield* provide(
				Effect.flatMap(Github, (gh) => gh.read(SHA)),
				{
					// Split across two pages, with a context's superseding run on the SECOND page:
					// a shell that dropped a page would resolve this head red.
					[checkRunsPath]: pages(
						[
							checkRun({
								name: "ci-required",
								conclusion: "failure",
								started_at: "2026-07-22T05:50:04Z",
								id: 1,
							}),
							checkRun({
								name: "e2e",
								conclusion: "failure",
								started_at: "2026-07-22T05:58:40Z",
								id: 3,
							}),
						],
						[
							checkRun({
								name: "ci-required",
								conclusion: "success",
								started_at: "2026-07-22T06:21:26Z",
								id: 2,
							}),
							checkRun({
								name: "e2e",
								conclusion: "skipped",
								started_at: "2026-07-22T06:21:23Z",
								id: 4,
							}),
						],
					),
					[statusPath]: noStatuses,
				},
			);
			assert.strictEqual(rollup.conclusion, "green");
			assert.strictEqual(rollup.latest.length, 2);
			assert.deepStrictEqual(rollup.failing, []);
		}),
	);

	it.effect("a check run with no started_at still decodes and rolls up", () =>
		Effect.gen(function* () {
			const rollup = yield* provide(
				Effect.flatMap(Github, (gh) => gh.read(SHA)),
				{
					[checkRunsPath]: pages([
						{id: 1, name: "lint", conclusion: "failure", completed_at: null},
						{id: 2, name: "lint", conclusion: "success", completed_at: null},
					]),
					[statusPath]: noStatuses,
				},
			);
			assert.strictEqual(rollup.conclusion, "green");
		}),
	);
});

describe("Github.read — the three CI states survive the decode boundary", () => {
	it.effect("a queued run with no start time decodes as wedged, not as running", () =>
		Effect.gen(function* () {
			const rollup = yield* provide(
				Effect.flatMap(Github, (gh) => gh.read(SHA)),
				{
					[checkRunsPath]: pages([
						{
							id: 1,
							name: "fanout-guard",
							status: "queued",
							conclusion: null,
							started_at: null,
							completed_at: null,
						},
					]),
					[statusPath]: noStatuses,
				},
			);
			assert.strictEqual(rollup.conclusion, "pending");
			assert.deepStrictEqual(
				rollup.wedged.map((c) => c.name),
				["fanout-guard"],
			);
			assert.deepStrictEqual(rollup.running, []);
		}),
	);

	it.effect("zero-run check suites are reported inert and leave a completed head green", () =>
		Effect.gen(function* () {
			const rollup = yield* provide(
				Effect.flatMap(Github, (gh) => gh.read(SHA)),
				{
					[checkRunsPath]: pages([
						{
							id: 1,
							name: "ci-required",
							status: "completed",
							conclusion: "success",
							started_at: "2026-07-25T05:40:00Z",
							completed_at: "2026-07-25T05:48:16Z",
						},
					]),
					[checkSuitesPath]: JSON.stringify([
						{
							check_suites: [
								{id: 10, status: "queued", latest_check_runs_count: 0, app: {slug: "vercel"}},
								{
									id: 11,
									status: "completed",
									latest_check_runs_count: 1,
									app: {slug: "github-actions"},
								},
							],
						},
					]),
					[statusPath]: noStatuses,
				},
			);
			assert.strictEqual(rollup.conclusion, "green");
			assert.deepStrictEqual(
				rollup.inertSuites.map((s) => s.appSlug),
				["vercel"],
			);
		}),
	);

	// Suites are diagnosis only, so an unreadable suites read must not block a merge — the
	// verdict is unchanged and the inert list is simply empty.
	it.effect("an unreadable check-suites read degrades instead of refusing", () =>
		Effect.gen(function* () {
			const rollup = yield* provide(
				Effect.flatMap(Github, (gh) => gh.read(SHA)),
				{
					[checkRunsPath]: pages([
						{
							id: 1,
							name: "ci-required",
							status: "completed",
							conclusion: "success",
							started_at: "2026-07-25T05:40:00Z",
							completed_at: "2026-07-25T05:48:16Z",
						},
					]),
					[statusPath]: noStatuses,
				},
			);
			assert.strictEqual(rollup.conclusion, "green");
			assert.deepStrictEqual(rollup.inertSuites, []);
		}),
	);
});

describe("Github.read — an unreadable head is the typed unknown, never a colour", () => {
	const expectUnreadable = (responses: Record<string, string>) =>
		Effect.gen(function* () {
			const outcome = yield* Effect.result(
				provide(
					Effect.flatMap(Github, (gh) => gh.read(SHA)),
					responses,
				),
			);
			assert.strictEqual(outcome._tag, "Failure");
			assert.strictEqual(
				(outcome as {failure: {_tag: string}}).failure._tag,
				"@kampus/checks/HeadCiUnreadable",
			);
		});

	// The body a failed `gh api` prints is an ERROR OBJECT, not a page array. Shape-check first:
	// interpreting it as data is how an unreadable head becomes a fabricated verdict.
	it.effect("an error body where the pages array belongs is unreadable", () =>
		expectUnreadable({
			[checkRunsPath]: JSON.stringify({message: "Not Found", status: "404"}),
			[statusPath]: noStatuses,
		}),
	);

	it.effect("a page whose check_runs is not an array is unreadable", () =>
		expectUnreadable({
			[checkRunsPath]: JSON.stringify([{check_runs: "oops"}]),
			[statusPath]: noStatuses,
		}),
	);

	it.effect("unparseable output is unreadable", () =>
		expectUnreadable({[checkRunsPath]: "<html>502 Bad Gateway</html>", [statusPath]: noStatuses}),
	);

	it.effect("a check-runs read that fails outright is unreadable", () =>
		expectUnreadable({[statusPath]: noStatuses}),
	);
});

describe("Github.headSha — resolves the PR's current head", () => {
	it.effect("reads .head.sha off the pulls endpoint", () =>
		Effect.gen(function* () {
			const sha = yield* provide(
				Effect.flatMap(Github, (gh) => gh.headSha(3733)),
				{[`repos/${PINNED_REPO}/pulls/3733`]: JSON.stringify({head: {sha: SHA}})},
			);
			assert.strictEqual(sha, SHA);
		}),
	);
});
