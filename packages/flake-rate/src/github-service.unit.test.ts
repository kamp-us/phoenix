/**
 * `Github` over a fake `ChildProcessSpawner` — the capability-seam test (#855).
 *
 * The pure decode core is covered in `github.unit.test.ts`; this file crosses the
 * IO seam (`.patterns/effect-context-service.md`) by driving `GithubLive` over a
 * fake spawner — the `mockSpawner` idiom established in
 * `@kampus/epic-ledger`'s `github-service.unit.test.ts` — so the branchy
 * orchestration behind it is reachable without spawning the real `gh`:
 *   - `resolveRepo`'s 3-tier resolution (env override → `GITHUB_REPOSITORY` →
 *     `gh repo view`, then `RepoResolutionError`), proved purely from which
 *     `repos/<repo>/...` fixture key the read hits;
 *   - the unmerged-PR drop in `inventoryFixes` (a `merged_at: null` fixing PR is
 *     skipped — its flake keeps tripping the budget, the safe default).
 */
import {afterEach, assert, describe, it} from "@effect/vitest";
import {Cause, Effect, type Exit, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {Github, GithubLive, RepoResolutionError} from "./github.ts";

interface Canned {
	readonly stdout: string;
	readonly exitCode?: number;
	readonly stderr?: string;
}

type Response = string | Canned;

const enc = new TextEncoder();

const normalize = (response: Response): Canned =>
	typeof response === "string" ? {stdout: response} : response;

/**
 * A `ChildProcessSpawner` that answers `gh api <path>` from a fixture map (keyed
 * on the addressed REST path, query stripped) and `gh repo view …` from
 * `repoView`. An unmapped path exits 1 (a not-found). `counter`, when passed,
 * tallies total spawns and `repo view` spawns — proof a test never shelled real
 * `gh` and that resolution is cached.
 */
const mockSpawner = (
	responses: Record<string, Response>,
	repoView?: Response,
	counter?: {count: number; repoView: number},
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				if (counter) counter.count += 1;
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const isRepoView = args[0] === "repo" && args[1] === "view";
				if (isRepoView && counter) counter.repoView += 1;
				const rawPath = args.find((a) => a.startsWith("repos/")) ?? "";
				const path = rawPath.replace(/\?.*$/, "");
				const found = isRepoView
					? (repoView ?? {stdout: "", exitCode: 1, stderr: "no repo"})
					: responses[path];
				const canned = found
					? normalize(found)
					: {stdout: "", exitCode: 1, stderr: `not found: ${path}`};
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

// Repo resolution reads `process.env` on first method call (ADR 0062 §1). Each
// test sets the env it wants synchronously around `Effect.runPromiseExit` and the
// afterEach restores it — `it.effect` can't bracket the run the way this needs.
const ENV_KEYS = ["CLAUDE_PIPELINE_REPO", "GITHUB_REPOSITORY"] as const;
let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;
afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

const withEnv = <A, E>(
	env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
	program: Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> => {
	saved = {CLAUDE_PIPELINE_REPO: undefined, GITHUB_REPOSITORY: undefined};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	for (const key of ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) process.env[key] = value;
	}
	return Effect.runPromiseExit(program);
};

const runsPath = (repo: string, workflow: string) =>
	`repos/${repo}/actions/workflows/${workflow}/runs`;

const RUN = {
	run_number: 1,
	run_attempt: 1,
	conclusion: "success",
	head_branch: "main",
	created_at: "2026-06-20T00:00:00Z",
};

const runsBody = JSON.stringify({workflow_runs: [RUN]});

const WINDOW = {workflow: "ci.yml", branch: "main", perPage: 50} as const;

const drive = <A, E>(
	effect: Effect.Effect<A, E, Github>,
	responses: Record<string, Response>,
	repoView?: Response,
	counter?: {count: number; repoView: number},
) =>
	effect.pipe(
		Effect.provide(GithubLive.pipe(Layer.provide(mockSpawner(responses, repoView, counter)))),
	);

describe("GithubLive — target repo resolution (ADR 0062 §1) over a fake spawner", () => {
	// A read only succeeds if the resolved repo became the `repos/<repo>/...` URL
	// prefix the fixture is keyed on; a wrong repo 404s. So a successful read proves
	// which repo was resolved.
	it("CLAUDE_PIPELINE_REPO wins; gh repo view is never consulted", async () => {
		const counter = {count: 0, repoView: 0};
		const program = Github.pipe(Effect.flatMap((g) => g.workflowRuns(WINDOW)));
		const exit = await withEnv(
			{CLAUDE_PIPELINE_REPO: "foo/bar", GITHUB_REPOSITORY: "ci/env"},
			drive(
				program,
				{[runsPath("foo/bar", "ci.yml")]: runsBody},
				{stdout: "view/repo"}, // would mis-route if ever consulted
				counter,
			),
		);
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") assert.strictEqual(exit.value.length, 1);
		assert.strictEqual(counter.repoView, 0);
	});

	it("GITHUB_REPOSITORY is used when CLAUDE_PIPELINE_REPO is unset", async () => {
		const program = Github.pipe(Effect.flatMap((g) => g.workflowRuns(WINDOW)));
		const exit = await withEnv(
			{GITHUB_REPOSITORY: "octo/cat"},
			drive(program, {[runsPath("octo/cat", "ci.yml")]: runsBody}, {stdout: "view/repo"}),
		);
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") assert.strictEqual(exit.value.length, 1);
	});

	it("falls back to `gh repo view` when no env is set", async () => {
		const program = Github.pipe(Effect.flatMap((g) => g.workflowRuns(WINDOW)));
		const exit = await withEnv(
			{},
			drive(program, {[runsPath("from/view", "ci.yml")]: runsBody}, {stdout: "from/view\n"}),
		);
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") assert.strictEqual(exit.value.length, 1);
	});

	it("fails RepoResolutionError when nothing resolves (no env, gh repo view errors)", async () => {
		const program = Github.pipe(Effect.flatMap((g) => g.workflowRuns(WINDOW)));
		const exit = await withEnv(
			{},
			drive(program, {}, {stdout: "", exitCode: 1, stderr: "not a git repo"}),
		);
		assert.isTrue(exit._tag === "Failure");
		if (exit._tag === "Failure") {
			assert.isTrue(Cause.squash(exit.cause) instanceof RepoResolutionError);
		}
	});

	it("resolves the repo once and caches it across calls (one `gh repo view`)", async () => {
		const counter = {count: 0, repoView: 0};
		const program = Effect.gen(function* () {
			const github = yield* Github;
			yield* github.workflowRuns(WINDOW);
			yield* github.workflowRuns(WINDOW);
		});
		const exit = await withEnv(
			{},
			drive(
				program,
				{[runsPath("from/view", "ci.yml")]: runsBody},
				{stdout: "from/view\n"},
				counter,
			),
		);
		assert.isTrue(exit._tag === "Success");
		// `gh repo view` runs exactly once despite two reads — resolution is cached.
		assert.strictEqual(counter.repoView, 1);
	});
});

describe("GithubLive.workflowRuns — over a fake spawner", () => {
	it("decodes the workflow-runs envelope into domain WorkflowRun[]", async () => {
		const body = JSON.stringify({
			workflow_runs: [
				{...RUN, run_number: 10, run_attempt: 2},
				{...RUN, run_number: 11, run_attempt: 1},
			],
		});
		const program = Github.pipe(Effect.flatMap((g) => g.workflowRuns(WINDOW)));
		const exit = await withEnv(
			{CLAUDE_PIPELINE_REPO: "kamp-us/phoenix"},
			drive(program, {[runsPath("kamp-us/phoenix", "ci.yml")]: body}),
		);
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") {
			assert.deepStrictEqual(
				exit.value.map((r) => ({n: r.runNumber, a: r.runAttempt})),
				[
					{n: 10, a: 2},
					{n: 11, a: 1},
				],
			);
		}
	});
});

const inventory = (entries: ReadonlyArray<{heading: string; pr: number}>): string =>
	entries.map((e) => `### ${e.heading}\n- **Status:** \`fixed\` PR #${e.pr}\n`).join("\n");

describe("GithubLive.inventoryFixes — unmerged-PR drop over a fake spawner", () => {
	const REPO = "kamp-us/phoenix";
	const pullPath = (pr: number) => `repos/${REPO}/pulls/${pr}`;

	it("keeps a fixing PR with a merged_at and drops an unmerged (null) one", async () => {
		const markdown = inventory([
			{heading: "flake A", pr: 101},
			{heading: "flake B", pr: 102},
		]);
		const program = Github.pipe(Effect.flatMap((g) => g.inventoryFixes(markdown)));
		const exit = await withEnv(
			{CLAUDE_PIPELINE_REPO: REPO},
			drive(program, {
				[pullPath(101)]: JSON.stringify({number: 101, merged_at: "2026-06-19T12:00:00Z"}),
				[pullPath(102)]: JSON.stringify({number: 102, merged_at: null}),
			}),
		);
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") {
			// #101 merged → carried with its fixedAt boundary; #102 unmerged → dropped.
			assert.deepStrictEqual(
				exit.value.map((f) => f.ref),
				["flake A (PR #101)"],
			);
			assert.strictEqual(exit.value[0]?.fixedAt, "2026-06-19T12:00:00Z");
		}
	});

	it("an empty inventory resolves to no fixes (no pulls read)", async () => {
		const counter = {count: 0, repoView: 0};
		const program = Github.pipe(Effect.flatMap((g) => g.inventoryFixes("no entries here")));
		const exit = await withEnv(
			{CLAUDE_PIPELINE_REPO: REPO},
			drive(program, {}, undefined, counter),
		);
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") assert.deepStrictEqual(exit.value, []);
		// No env-less resolution and no parsed entries → zero spawns.
		assert.strictEqual(counter.count, 0);
	});
});
