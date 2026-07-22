import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {Github, GithubLive, RepoResolutionError} from "./github.ts";
import {decideMergeIntent} from "./merge-intent.ts";

// The live `Github` layer resolves its target repo lazily (ADR 0062 §1): `--repo` →
// `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`. Clear the ambient env so no
// var leaks into the resolution branches these tests exercise.
let savedRepo: string | undefined;
let savedGh: string | undefined;
beforeAll(() => {
	savedRepo = process.env.CLAUDE_PIPELINE_REPO;
	savedGh = process.env.GITHUB_REPOSITORY;
	delete process.env.CLAUDE_PIPELINE_REPO;
	delete process.env.GITHUB_REPOSITORY;
});
afterAll(() => {
	if (savedRepo === undefined) delete process.env.CLAUDE_PIPELINE_REPO;
	else process.env.CLAUDE_PIPELINE_REPO = savedRepo;
	if (savedGh === undefined) delete process.env.GITHUB_REPOSITORY;
	else process.env.GITHUB_REPOSITORY = savedGh;
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

/**
 * A `ChildProcessSpawner` answering the three calls the service makes: the `gh api …/pulls/<n>`
 * read, the `gh api …/timeline` read, and the `gh pr merge --disable-auto` write. `pull` may be a
 * list, consumed one per call, so a test can model the state BEFORE and AFTER the disable — the
 * read-back verify's whole point. An unprovided call exits 1 (the read-failure path).
 */
const mockSpawner = (fixture: {
	readonly pull?: Response | ReadonlyArray<Response>;
	readonly timeline?: Response;
	readonly disable?: Response;
	readonly repoView?: Response;
}): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
	const pulls = Array.isArray(fixture.pull)
		? [...(fixture.pull as ReadonlyArray<Response>)]
		: fixture.pull === undefined
			? []
			: [fixture.pull as Response];
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const isRepoView = args[0] === "repo" && args[1] === "view";
				const isDisable = args.includes("--disable-auto");
				const isTimeline = args.some((a) => a.includes("/timeline"));
				const isPull = args.some((a) => a.includes("/pulls/"));
				const pick = (): Response | undefined =>
					isRepoView
						? fixture.repoView
						: isDisable
							? fixture.disable
							: isTimeline
								? fixture.timeline
								: isPull
									? (pulls.shift() ?? pulls.at(-1))
									: undefined;
				const found = pick();
				// `!== undefined`, not truthiness: an empty stdout is a legitimate canned success
				// (`gh pr merge --disable-auto` prints nothing), not an unprovided call.
				const canned =
					found !== undefined ? normalize(found) : {stdout: "", exitCode: 1, stderr: "not found"};
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
};

const provide = <A, E>(
	effect: Effect.Effect<A, E, Github>,
	fixture: Parameters<typeof mockSpawner>[0],
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(Effect.provide(GithubLive.pipe(Layer.provide(mockSpawner(fixture)))));

/** The `--jq`-projected PR read the service issues. */
const pull = (merged: boolean, armed: boolean): string => JSON.stringify({merged, armed});

const timelineEvents = (...events: ReadonlyArray<string>): string =>
	JSON.stringify(events.map((event, i) => ({event, created_at: `2026-01-01T00:0${i}:00Z`})));

const REPO = "kamp-us/phoenix";

describe("Github.state — the live merge state the ADR-0198 branch reads", () => {
	it.effect("reports an armed, never-queued PR", () =>
		Effect.gen(function* () {
			const state = yield* (yield* Github).state(3700, REPO);
			assert.deepStrictEqual(state, {
				merged: false,
				armed: true,
				queued: false,
				everQueued: false,
			});
		}).pipe((effect) => provide(effect, {pull: pull(false, true), timeline: "[]"})),
	);

	it.effect("reports a PR the queue governs but has dropped — the parked-intent shape", () =>
		Effect.gen(function* () {
			const state = yield* (yield* Github).state(3700, REPO);
			assert.strictEqual(state.queued, false);
			assert.strictEqual(state.everQueued, true);
			assert.strictEqual(decideMergeIntent("post-enqueue", state).action, "disarm");
		}).pipe((effect) =>
			provide(effect, {
				pull: pull(false, true),
				timeline: timelineEvents("added_to_merge_queue", "removed_from_merge_queue"),
			}),
		),
	);

	it.effect("a queued PR is never disarmed at any site", () =>
		Effect.gen(function* () {
			const state = yield* (yield* Github).state(3700, REPO);
			assert.strictEqual(state.queued, true);
			assert.strictEqual(decideMergeIntent("preflight", state).action, "keep");
		}).pipe((effect) =>
			provide(effect, {pull: pull(false, true), timeline: timelineEvents("added_to_merge_queue")}),
		),
	);

	it.effect("fail-closed: an unreadable PR read yields armed=unknown ⇒ disarm", () =>
		Effect.gen(function* () {
			const state = yield* (yield* Github).state(3700, REPO);
			assert.strictEqual(state.armed, "unknown");
			assert.strictEqual(decideMergeIntent("refuse", state).action, "disarm");
		}).pipe((effect) => provide(effect, {timeline: "[]"})),
	);

	it.effect("no --repo override and an unresolvable repo fails RepoResolutionError", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip((yield* Github).state(3700));
			assert.isTrue(error instanceof RepoResolutionError);
		}).pipe((effect) => provide(effect, {pull: pull(false, true), timeline: "[]"})),
	);
});

describe("Github.disarm — the read-back verify carries the guarantee, not the exit code", () => {
	it.effect("confirms `cleared` when auto_merge reads null after the disable", () =>
		Effect.gen(function* () {
			const outcome = yield* (yield* Github).disarm(3700, REPO);
			assert.strictEqual(outcome.cleared, true);
			assert.strictEqual(outcome.exitCode, 0);
		}).pipe((effect) => provide(effect, {pull: [pull(false, false)], disable: "", timeline: "[]"})),
	);

	it.effect("tolerates a non-zero disable when the read-back is clean (nothing was armed)", () =>
		Effect.gen(function* () {
			// `gh pr merge --disable-auto` errors when there is no auto-merge to disable; the
			// invariant is still satisfied, so the exit code alone must not read as a failure.
			const outcome = yield* (yield* Github).disarm(3700, REPO);
			assert.strictEqual(outcome.cleared, true);
			assert.strictEqual(outcome.exitCode, 1);
			assert.match(outcome.stderr, /not in the auto-merge state/);
		}).pipe((effect) =>
			provide(effect, {
				pull: [pull(false, false)],
				disable: {stdout: "", exitCode: 1, stderr: "Pull request is not in the auto-merge state"},
				timeline: "[]",
			}),
		),
	);

	it.effect("reports NOT cleared when the intent is still armed after the disable", () =>
		Effect.gen(function* () {
			const outcome = yield* (yield* Github).disarm(3700, REPO);
			assert.strictEqual(outcome.cleared, false);
		}).pipe((effect) => provide(effect, {pull: [pull(false, true)], disable: "", timeline: "[]"})),
	);

	it.effect("reports NOT cleared when the read-back itself is unreadable (unverifiable)", () =>
		Effect.gen(function* () {
			// armed reads `unknown` ⇒ the clear cannot be proven ⇒ the bin fails loud.
			const outcome = yield* (yield* Github).disarm(3700, REPO);
			assert.strictEqual(outcome.cleared, false);
		}).pipe((effect) => provide(effect, {disable: "", timeline: "[]"})),
	);
});
