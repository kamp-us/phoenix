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

interface Canned {
	readonly stdout: string;
	readonly exitCode?: number;
	readonly stderr?: string;
}
type Response = string | Canned;

const enc = new TextEncoder();
const normalize = (response: Response): Canned =>
	typeof response === "string" ? {stdout: response} : response;

/** A `ChildProcessSpawner` answering `gh api` from a REST-path fixture map. */
const mockSpawner = (
	responses: Record<string, Response>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const path = (args.find((a) => a.startsWith("repos/")) ?? "").replace(/\?.*$/, "");
				const canned =
					path in responses
						? normalize(responses[path]!)
						: {stdout: "", exitCode: 1, stderr: `gh: Not Found (HTTP 404) ${path}`};
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

const provide = <A, E>(
	effect: Effect.Effect<A, E, Github>,
	responses: Record<string, Response>,
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(Effect.provide(GithubLive.pipe(Layer.provide(mockSpawner(responses)))));

const issuePath = (n: number) => `repos/${PINNED_REPO}/issues/${n}`;
const triaged = JSON.stringify({labels: [{name: "status:triaged"}, {name: "p1"}]});
const untriaged = JSON.stringify({labels: [{name: "status:needs-triage"}]});
const notFound = {stdout: "", exitCode: 1, stderr: "gh: Not Found (HTTP 404)"} as const;
const serverError = {
	stdout: "",
	exitCode: 1,
	stderr: "gh: No server is currently available to service your request. (HTTP 503)",
} as const;

const laneOf = (body: string, responses: Record<string, Response>) =>
	provide(
		Effect.flatMap(Github, (gh) => gh.inEngineLane(body)),
		responses,
	);

const SHA = "bb21a70f0000000000000000000000000000dead";
const checkRunsPath = `repos/${PINNED_REPO}/commits/${SHA}/check-runs`;
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

const headCiOf = (responses: Record<string, Response>) =>
	provide(
		Effect.flatMap(Github, (gh) => gh.headCi(SHA)),
		responses,
	);

describe("Github.headCi — the head read is latest-per-context (#3762)", () => {
	// The live reproduction: PR #3733's head carried three `ci-required` runs — the latest
	// green, two superseded reds — and the naive filter opened a repair lane on a green PR.
	it.effect("a superseded red whose context has since gone green reads green", () =>
		Effect.gen(function* () {
			const ci = yield* headCiOf({
				[checkRunsPath]: pages([
					checkRun({
						name: "ci-required",
						conclusion: "failure",
						started_at: "2026-07-22T05:50:04Z",
						id: 1,
					}),
					checkRun({
						name: "ci-required",
						conclusion: "failure",
						started_at: "2026-07-22T06:09:51Z",
						id: 2,
					}),
					checkRun({
						name: "ci-required",
						conclusion: "success",
						started_at: "2026-07-22T06:21:26Z",
						id: 3,
					}),
				]),
				[statusPath]: noStatuses,
			});
			assert.strictEqual(ci.conclusion, "green");
		}),
	);

	it.effect("a context whose latest run failed is still red, with its name and red-since", () =>
		Effect.gen(function* () {
			const ci = yield* headCiOf({
				[checkRunsPath]: pages([
					checkRun({
						name: "ci-required",
						conclusion: "success",
						started_at: "2026-07-22T05:50:04Z",
						id: 1,
					}),
					checkRun({
						name: "ci-required",
						conclusion: "failure",
						started_at: "2026-07-22T06:21:26Z",
						id: 2,
					}),
				]),
				[statusPath]: noStatuses,
			});
			assert.strictEqual(ci.conclusion, "red");
			assert.strictEqual(ci.failingCheck, "ci-required");
			assert.strictEqual(ci.redSince, "2026-07-22T06:21:26Z");
		}),
	);

	it.effect("an unconcluded latest run is pending", () =>
		Effect.gen(function* () {
			const ci = yield* headCiOf({
				[checkRunsPath]: pages([
					checkRun({name: "e2e", conclusion: null, started_at: "2026-07-22T06:21:26Z", id: 1}),
				]),
				[statusPath]: noStatuses,
			});
			assert.strictEqual(ci.conclusion, "pending");
		}),
	);
});

describe("Github.inEngineLane — a read that could not execute is `unknown`, never `laneless` (#3701)", () => {
	it.effect("a transient 5xx on the only closing ref defers instead of reading laneless", () =>
		Effect.gen(function* () {
			const lane = yield* laneOf("Fixes #10", {[issuePath(10)]: serverError});
			assert.strictEqual(lane, "unknown");
		}),
	);

	it.effect("a genuine 404 closing ref still resolves laneless without aborting the sweep", () =>
		Effect.gen(function* () {
			const lane = yield* laneOf("Fixes #10", {[issuePath(10)]: notFound});
			assert.strictEqual(lane, "laneless");
		}),
	);

	it.effect("an undecodable payload resolves laneless (a bad ref, not an outage)", () =>
		Effect.gen(function* () {
			const lane = yield* laneOf("Fixes #10", {[issuePath(10)]: "{not json"});
			assert.strictEqual(lane, "laneless");
		}),
	);

	it.effect("a triaged closing ref is laned", () =>
		Effect.gen(function* () {
			const lane = yield* laneOf("Fixes #10", {[issuePath(10)]: triaged});
			assert.strictEqual(lane, "laned");
		}),
	);

	it.effect("a read that found no triaged label is confirmed laneless", () =>
		Effect.gen(function* () {
			const lane = yield* laneOf("Fixes #10", {[issuePath(10)]: untriaged});
			assert.strictEqual(lane, "laneless");
		}),
	);

	it.effect("a PR with no closing refs is laneless — nothing was read, nothing to defer on", () =>
		Effect.gen(function* () {
			const lane = yield* laneOf("no closing keyword here", {});
			assert.strictEqual(lane, "laneless");
		}),
	);

	// Precedence: `laned` is provable from one ref, `laneless` is not — it needs every ref read.
	it.effect("one confirmed triaged ref wins over an unreadable sibling ref", () =>
		Effect.gen(function* () {
			const lane = yield* laneOf("Fixes #10, fixes #11", {
				[issuePath(10)]: triaged,
				[issuePath(11)]: serverError,
			});
			assert.strictEqual(lane, "laned");
		}),
	);

	it.effect("an unreadable ref alongside a confirmed-untriaged ref still defers", () =>
		Effect.gen(function* () {
			const lane = yield* laneOf("Fixes #10, fixes #11", {
				[issuePath(10)]: untriaged,
				[issuePath(11)]: serverError,
			});
			assert.strictEqual(lane, "unknown");
		}),
	);
});
