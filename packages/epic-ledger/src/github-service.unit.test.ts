import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Cause, Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {GhCommandError, GhParseError, Github, GithubLive, RepoResolutionError} from "./github.ts";
import {validateLedger} from "./validate.ts";

// The live `Github` layer resolves its target repo lazily on first method call
// (ADR 0062 §1, deferred per #422): env override first, else `gh repo view`. These
// tests pin the env override to `kamp-us/phoenix` so the fixtures keyed on
// `repos/kamp-us/phoenix/...` match without depending on the ambient `gh repo
// view`. The resolution-order describe below clears it to exercise the other
// branches explicitly.
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

/** A canned `gh` response keyed by the URL path the args address. */
interface Canned {
	readonly stdout: string;
	readonly exitCode?: number;
	readonly stderr?: string;
}

/** A response is either the raw stdout JSON string, or a full `Canned`. */
type Response = string | Canned;

const enc = new TextEncoder();

const normalize = (response: Response): Canned =>
	typeof response === "string" ? {stdout: response} : response;

/**
 * A `ChildProcessSpawner` that answers `gh api <path>` from a fixture map, plus
 * `gh repo view …` from the `repoView` key. The args are flattened to the
 * addressed REST path so a test states only the responses, not the spawn
 * mechanics. An unmapped path exits 1 (a not-found).
 */
const mockSpawner = (
	responses: Record<string, Response>,
	repoView?: Response,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const isRepoView = args[0] === "repo" && args[1] === "view";
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

const provide = <A, E>(
	effect: Effect.Effect<A, E, Github>,
	responses: Record<string, Response>,
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(Effect.provide(GithubLive.pipe(Layer.provide(mockSpawner(responses)))));

const issue = (number: number, body: string, labels: string[]) =>
	JSON.stringify({
		number,
		title: `#${number}`,
		labels: labels.map((name) => ({name})),
		body,
	});

const EPIC_BODY = [
	"### User stories",
	"1. As a planner, I want X.",
	"2. As an agent, I want Y.",
	"",
	"## Dependencies",
	"- #101",
	"- #102",
].join("\n");

describe("Github.epicLedger — over a mock gh spawner", () => {
	it.effect("assembles a clean, story-covered EpicLedger consumable by validateLedger", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const ledger = yield* github.epicLedger(159);
			assert.strictEqual(ledger.epic.number, 159);
			assert.deepStrictEqual(ledger.epic.stories, [1, 2]);
			assert.strictEqual(ledger.children.length, 2);
			assert.deepStrictEqual(ledger.children[0]?.stories, [1]);
			assert.deepStrictEqual(ledger.children[1]?.stories, [2]);
			assert.deepStrictEqual(validateLedger(ledger), []);
		}).pipe((effect) =>
			provide(effect, {
				"repos/kamp-us/phoenix/issues/159": issue(159, EPIC_BODY, [
					"type:epic",
					"p1",
					"status:triaged",
				]),
				"repos/kamp-us/phoenix/issues/159/sub_issues": JSON.stringify([
					{number: 101},
					{number: 102},
				]),
				"repos/kamp-us/phoenix/issues/101": issue(
					101,
					"**Stories:** 1\n### Acceptance criteria\n- [ ] ac",
					["type:feature", "p1", "status:triaged"],
				),
				"repos/kamp-us/phoenix/issues/102": issue(
					102,
					"**Stories:** 2\n### Acceptance criteria\n- [ ] ac",
					["type:feature", "p1", "status:triaged"],
				),
			}),
		),
	);

	it.effect("surfaces a non-zero `gh` exit as a typed GhCommandError (not a throw)", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const error = yield* Effect.flip(github.epicLedger(404));
			assert.isTrue(error instanceof GhCommandError);
			if (error instanceof GhCommandError) assert.strictEqual(error.exitCode, 1);
		}).pipe((effect) => provide(effect, {})),
	);

	it.effect("surfaces malformed gh JSON as a typed GhParseError (not a throw)", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const error = yield* Effect.flip(github.epicLedger(159));
			assert.isTrue(error instanceof GhParseError);
		}).pipe((effect) =>
			provide(effect, {
				"repos/kamp-us/phoenix/issues/159": "not json {{{",
			}),
		),
	);
});

const XREF_BODY = [
	"### User stories",
	"1. As a planner, I want X.",
	"",
	"## Dependencies",
	"### Phase 1",
	"- #101 — a",
	"- #102 — b (requires: #101, #108)",
].join("\n");

const xrefResponses = (epicNumber: number): Record<string, Response> => ({
	[`repos/kamp-us/phoenix/issues/${epicNumber}`]: issue(epicNumber, XREF_BODY, [
		"type:epic",
		"p1",
		"status:triaged",
	]),
	[`repos/kamp-us/phoenix/issues/${epicNumber}/sub_issues`]: JSON.stringify([
		{number: 101},
		{number: 102},
	]),
	"repos/kamp-us/phoenix/issues/101": issue(
		101,
		"**Stories:** 1\n### Acceptance criteria\n- [ ] ac",
		["type:feature", "p1", "status:triaged"],
	),
	"repos/kamp-us/phoenix/issues/102": issue(
		102,
		"**Stories:** 1\n### Acceptance criteria\n- [ ] ac",
		["type:feature", "p1", "status:triaged"],
	),
});

describe("Github.epicLedger — cross-epic dependency resolution at the boundary", () => {
	it.effect(
		"a `requires:` ref to a real non-child issue resolves to externalRefs, not DANGLING_DEP",
		() =>
			Effect.gen(function* () {
				const github = yield* Github;
				const ledger = yield* github.epicLedger(160);
				// #108 is referenced via `requires:` but is not a linked child; it resolves
				// to a real issue, so it rides in externalRefs and is not flagged dangling.
				assert.deepStrictEqual(ledger.externalRefs, [108]);
				assert.notInclude(
					validateLedger(ledger).map((d) => d.type),
					"DANGLING_DEP",
				);
			}).pipe((effect) =>
				provide(effect, {
					...xrefResponses(160),
					"repos/kamp-us/phoenix/issues/108": issue(108, "a cross-epic dependency", [
						"type:feature",
						"p2",
						"status:triaged",
					]),
				}),
			),
	);

	it.effect("a `requires:` ref that 404s is left out of externalRefs and still DANGLES", () =>
		Effect.gen(function* () {
			const github = yield* Github;
			const ledger = yield* github.epicLedger(161);
			// #108 is unmapped → the probe 404s → it is not resolved, so it dangles.
			assert.deepStrictEqual(ledger.externalRefs, []);
			const dangling = validateLedger(ledger).find((d) => d.type === "DANGLING_DEP");
			assert.isDefined(dangling);
			assert.deepStrictEqual(dangling?.refs, [108]);
		}).pipe((effect) => provide(effect, xrefResponses(161))),
	);
});

// The repo the layer resolves to is the prefix of every `gh api repos/<repo>/...`
// URL. A single-issue epic over a chosen repo lets a test prove which repo was
// resolved purely from which fixture key the read hit.
const soloResponses = (repo: string, epicNumber: number): Record<string, Response> => ({
	[`repos/${repo}/issues/${epicNumber}`]: issue(epicNumber, EPIC_BODY, [
		"type:epic",
		"p1",
		"status:triaged",
	]),
	[`repos/${repo}/issues/${epicNumber}/sub_issues`]: JSON.stringify([{number: 101}, {number: 102}]),
	[`repos/${repo}/issues/101`]: issue(101, "**Stories:** 1\n### Acceptance criteria\n- [ ] ac", [
		"type:feature",
		"p1",
		"status:triaged",
	]),
	[`repos/${repo}/issues/102`]: issue(102, "**Stories:** 2\n### Acceptance criteria\n- [ ] ac", [
		"type:feature",
		"p1",
		"status:triaged",
	]),
});

// Run an epicLedger read against a fixture map + a chosen `gh repo view` answer,
// with the repo-resolution env set exactly as the test wants. Resolution reads
// `process.env` on the first method call (deferred — #422), so env is set
// synchronously around `Effect.runPromiseExit` and restored after — `it.effect`
// can't bracket the run the way these tests need, so they run the effect by hand.
const runResolution = (params: {
	readonly env: {readonly CLAUDE_PIPELINE_REPO?: string; readonly GITHUB_REPOSITORY?: string};
	readonly responses: Record<string, Response>;
	readonly repoView?: Response;
	readonly epicNumber: number;
}) => {
	const prev = {
		CLAUDE_PIPELINE_REPO: process.env.CLAUDE_PIPELINE_REPO,
		GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
	};
	const restore = (
		key: "CLAUDE_PIPELINE_REPO" | "GITHUB_REPOSITORY",
		value: string | undefined,
	) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	delete process.env.CLAUDE_PIPELINE_REPO;
	delete process.env.GITHUB_REPOSITORY;
	if (params.env.CLAUDE_PIPELINE_REPO !== undefined)
		process.env.CLAUDE_PIPELINE_REPO = params.env.CLAUDE_PIPELINE_REPO;
	if (params.env.GITHUB_REPOSITORY !== undefined)
		process.env.GITHUB_REPOSITORY = params.env.GITHUB_REPOSITORY;
	const layer = GithubLive.pipe(Layer.provide(mockSpawner(params.responses, params.repoView)));
	const program = Github.pipe(
		Effect.flatMap((github) => github.epicLedger(params.epicNumber)),
		Effect.provide(layer),
	);
	return Effect.runPromiseExit(program).finally(() => {
		restore("CLAUDE_PIPELINE_REPO", prev.CLAUDE_PIPELINE_REPO);
		restore("GITHUB_REPOSITORY", prev.GITHUB_REPOSITORY);
	});
};

// A spy spawner that counts `gh` invocations and answers `repo view` from
// `repoView`. It lets a test assert that building the layer spawns nothing — the
// proof that repo resolution is deferred out of the layer build (#422).
const countingSpawner = (
	counter: {count: number; repoView: number},
	repoView: Response,
	responses: Record<string, Response> = {},
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				counter.count += 1;
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const isRepoView = args[0] === "repo" && args[1] === "view";
				if (isRepoView) counter.repoView += 1;
				const rawPath = args.find((a) => a.startsWith("repos/")) ?? "";
				const path = rawPath.replace(/\?.*$/, "");
				const canned = normalize(
					isRepoView ? repoView : (responses[path] ?? {stdout: "", exitCode: 1, stderr: "nf"}),
				);
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

describe("GithubLive — repo resolution is deferred to first use (#422)", () => {
	// `--help`/`--version` build the layer but call no method; the bug was that the
	// layer build itself resolved the repo and so ERRORed with no repo context. The
	// fix defers resolution into the methods — so merely acquiring the service (the
	// help/version path) must spawn nothing, even with no env and an unreadable repo.
	it("building the service resolves NO repo (help/version path spawns no gh)", async () => {
		const prev = {
			CLAUDE_PIPELINE_REPO: process.env.CLAUDE_PIPELINE_REPO,
			GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
		};
		delete process.env.CLAUDE_PIPELINE_REPO;
		delete process.env.GITHUB_REPOSITORY;
		const counter = {count: 0, repoView: 0};
		const program = Github.pipe(
			// acquire the service but call nothing — the shape of a --help/--version run
			Effect.as(undefined),
			Effect.provide(
				GithubLive.pipe(
					Layer.provide(
						countingSpawner(counter, {stdout: "", exitCode: 1, stderr: "not a git repo"}),
					),
				),
			),
		);
		const exit = await Effect.runPromiseExit(program).finally(() => {
			if (prev.CLAUDE_PIPELINE_REPO === undefined) delete process.env.CLAUDE_PIPELINE_REPO;
			else process.env.CLAUDE_PIPELINE_REPO = prev.CLAUDE_PIPELINE_REPO;
			if (prev.GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY;
			else process.env.GITHUB_REPOSITORY = prev.GITHUB_REPOSITORY;
		});
		assert.isTrue(exit._tag === "Success");
		assert.strictEqual(counter.count, 0);
		assert.strictEqual(counter.repoView, 0);
	});

	// The complement: a real method call DOES resolve (and reuse) the repo — proving
	// the deferral didn't break resolution, only moved it to where it is needed.
	it("a real method call resolves the repo lazily and reuses it (cached, once)", async () => {
		const prev = {
			CLAUDE_PIPELINE_REPO: process.env.CLAUDE_PIPELINE_REPO,
			GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
		};
		delete process.env.CLAUDE_PIPELINE_REPO;
		delete process.env.GITHUB_REPOSITORY;
		const counter = {count: 0, repoView: 0};
		const program = Effect.gen(function* () {
			const github = yield* Github;
			yield* github.epicLedger(159);
			yield* github.epicLedger(159);
		}).pipe(
			Effect.provide(
				GithubLive.pipe(
					Layer.provide(
						countingSpawner(counter, {stdout: "from/view\n"}, soloResponses("from/view", 159)),
					),
				),
			),
		);
		const exit = await Effect.runPromiseExit(program).finally(() => {
			if (prev.CLAUDE_PIPELINE_REPO === undefined) delete process.env.CLAUDE_PIPELINE_REPO;
			else process.env.CLAUDE_PIPELINE_REPO = prev.CLAUDE_PIPELINE_REPO;
			if (prev.GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY;
			else process.env.GITHUB_REPOSITORY = prev.GITHUB_REPOSITORY;
		});
		assert.isTrue(exit._tag === "Success");
		// `gh repo view` runs exactly once despite two epicLedger calls — the cached
		// resolution proves the repo is resolved lazily AND only once per process.
		assert.strictEqual(counter.repoView, 1);
	});
});

describe("GithubLive — target repo resolution (ADR 0062 §1)", () => {
	// The read only succeeds if the resolved repo became the `repos/<repo>/...` URL
	// prefix the fixture map is keyed on — a wrong repo (e.g. a phoenix default)
	// 404s against these fixtures. So a clean ledger == "resolved to this repo".
	it("CLAUDE_PIPELINE_REPO wins; gh repo view is never consulted", async () => {
		const exit = await runResolution({
			env: {CLAUDE_PIPELINE_REPO: "foo/bar"},
			responses: soloResponses("foo/bar", 159),
			repoView: {stdout: "kamp-us/phoenix"}, // would mis-route if ever consulted
			epicNumber: 159,
		});
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") assert.strictEqual(exit.value.epic.number, 159);
	});

	it("GITHUB_REPOSITORY is used when CLAUDE_PIPELINE_REPO is unset", async () => {
		const exit = await runResolution({
			env: {GITHUB_REPOSITORY: "octo/cat"},
			responses: soloResponses("octo/cat", 159),
			repoView: {stdout: "kamp-us/phoenix"},
			epicNumber: 159,
		});
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") assert.strictEqual(exit.value.epic.number, 159);
	});

	it("falls back to `gh repo view` when no env is set", async () => {
		const exit = await runResolution({
			env: {},
			responses: soloResponses("from/view", 159),
			repoView: {stdout: "from/view\n"},
			epicNumber: 159,
		});
		assert.isTrue(exit._tag === "Success");
		if (exit._tag === "Success") assert.strictEqual(exit.value.epic.number, 159);
	});

	it("fails RepoResolutionError when nothing resolves (no env, gh repo view errors)", async () => {
		const exit = await runResolution({
			env: {},
			responses: {},
			repoView: {stdout: "", exitCode: 1, stderr: "not a git repo"},
			epicNumber: 159,
		});
		assert.isTrue(exit._tag === "Failure");
		if (exit._tag === "Failure") {
			assert.isTrue(Cause.squash(exit.cause) instanceof RepoResolutionError);
		}
	});
});
