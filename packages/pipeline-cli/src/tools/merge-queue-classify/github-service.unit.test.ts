import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {GhCommandError, Github, GithubLive, RepoResolutionError} from "./github.ts";
import {classify} from "./merge-queue-classify.ts";

// The live `Github` layer resolves its target repo lazily on first `signals` call (ADR 0062 §1):
// the `--repo` override → `CLAUDE_PIPELINE_REPO` → `GITHUB_REPOSITORY` → `gh repo view`. These
// tests clear the ambient env so the override / `gh repo view` branches are exercised explicitly
// and no ambient var leaks in.
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
 * A `ChildProcessSpawner` answering the two reads `signals` makes: `gh pr view … --json` from
 * `prState`, and `gh api …/timeline` from `timeline`; plus `gh repo view` from `repoView`. An
 * unprovided read exits 1 (the read-failure path the fail-closed posture recovers from).
 */
const mockSpawner = (fixture: {
	readonly prState?: Response;
	readonly timeline?: Response;
	readonly repoView?: Response;
}): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				let cmd = command;
				while (cmd._tag === "PipedCommand") cmd = cmd.left;
				const args = cmd._tag === "StandardCommand" ? cmd.args : [];
				const isPrView = args[0] === "pr" && args[1] === "view";
				const isRepoView = args[0] === "repo" && args[1] === "view";
				const isTimeline = args.some((a) => a.includes("/timeline"));
				const pick = (): Response | undefined =>
					isPrView
						? fixture.prState
						: isRepoView
							? fixture.repoView
							: isTimeline
								? fixture.timeline
								: undefined;
				const found = pick();
				const canned = found ? normalize(found) : {stdout: "", exitCode: 1, stderr: "not found"};
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
	fixture: Parameters<typeof mockSpawner>[0],
): Effect.Effect<A, E | RepoResolutionError> =>
	effect.pipe(Effect.provide(GithubLive.pipe(Layer.provide(mockSpawner(fixture)))));

const prView = (state: string, mergeStateStatus?: string): string =>
	JSON.stringify({state, mergeStateStatus: mergeStateStatus ?? null});

const timelineEvents = (...events: ReadonlyArray<string>): string =>
	JSON.stringify(events.map((event, i) => ({event, created_at: `2026-01-01T00:0${i}:00Z`})));

const REPO = "kamp-us/phoenix";

describe("Github.signals — the ground-truth reads over a mock gh spawner (#2738)", () => {
	it.effect("classifies `merged` from state==MERGED (the terminal-success read)", () =>
		Effect.gen(function* () {
			const signals = yield* (yield* Github).signals(1906, REPO);
			assert.strictEqual(signals.merged, true);
			assert.strictEqual(classify(signals).outcome, "merged");
		}).pipe((effect) =>
			provide(effect, {
				prState: prView("MERGED"),
				timeline: timelineEvents("added_to_merge_queue", "removed_from_merge_queue"),
			}),
		),
	);

	it.effect("classifies `queued` from the last timeline event added_to_merge_queue", () =>
		Effect.gen(function* () {
			const signals = yield* (yield* Github).signals(1906, REPO);
			assert.strictEqual(signals.lastMergeQueueEvent, "added_to_merge_queue");
			assert.strictEqual(classify(signals).outcome, "queued");
		}).pipe((effect) =>
			provide(effect, {
				prState: prView("OPEN", "QUEUED"),
				timeline: timelineEvents("added_to_merge_queue"),
			}),
		),
	);

	it.effect("classifies `ejected` from the last timeline event removed_from_merge_queue", () =>
		Effect.gen(function* () {
			const signals = yield* (yield* Github).signals(1906, REPO);
			assert.strictEqual(classify(signals).outcome, "ejected");
		}).pipe((effect) =>
			provide(effect, {
				prState: prView("OPEN"),
				timeline: timelineEvents("added_to_merge_queue", "removed_from_merge_queue"),
			}),
		),
	);

	it.effect(
		"classifies `pending` when OPEN with no merge-queue timeline event (the settle window)",
		() =>
			Effect.gen(function* () {
				const signals = yield* (yield* Github).signals(1906, REPO);
				assert.strictEqual(signals.lastMergeQueueEvent, null);
				assert.strictEqual(classify(signals).outcome, "pending");
			}).pipe((effect) => provide(effect, {prState: prView("OPEN", "CLEAN"), timeline: "[]"})),
	);

	it.effect(
		"fail-closed: an unreadable timeline recovers to the settle window (null event), not an error",
		() =>
			Effect.gen(function* () {
				// PR state reads clean; the timeline read exits 1 (unprovided). The deliberate
				// recovery keeps the classifier polling — never a false `merged`/`ejected`.
				const signals = yield* (yield* Github).signals(1906, REPO);
				assert.strictEqual(signals.lastMergeQueueEvent, null);
				assert.strictEqual(classify(signals).outcome, "pending");
			}).pipe((effect) => provide(effect, {prState: prView("OPEN", "CLEAN")})),
	);

	it.effect("an unreadable PR state fails GhCommandError (the command maps it to pending)", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip((yield* Github).signals(1906, REPO));
			assert.isTrue(error instanceof GhCommandError);
		}).pipe((effect) => provide(effect, {timeline: timelineEvents("added_to_merge_queue")})),
	);

	it.effect("no --repo override and an unresolvable repo fails RepoResolutionError", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip((yield* Github).signals(1906));
			assert.isTrue(error instanceof RepoResolutionError);
		}).pipe((effect) => provide(effect, {prState: prView("OPEN")})),
	);
});
