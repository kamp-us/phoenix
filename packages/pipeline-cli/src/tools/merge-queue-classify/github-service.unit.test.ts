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
 * A `ChildProcessSpawner` answering the three reads `signals` makes: `gh pr view … --json` from
 * `prState`, `gh api …/timeline` from `timeline`, and `gh api …/commits?sha=…` from `baseCommits`;
 * plus `gh repo view` from `repoView`. An unprovided read exits 1 (the read-failure path the
 * fail-closed posture recovers from).
 */
const mockSpawner = (fixture: {
	readonly prState?: Response;
	readonly timeline?: Response;
	readonly baseCommits?: Response;
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
				const isBaseCommits = args.some((a) => a.includes("/commits?sha="));
				const pick = (): Response | undefined =>
					isPrView
						? fixture.prState
						: isRepoView
							? fixture.repoView
							: isTimeline
								? fixture.timeline
								: isBaseCommits
									? fixture.baseCommits
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

const prView = (state: string, mergeStateStatus?: string, baseRefName?: string): string =>
	JSON.stringify({
		state,
		mergeStateStatus: mergeStateStatus ?? null,
		baseRefName: baseRefName ?? null,
	});

const baseCommits = (...subjects: ReadonlyArray<string>): string =>
	JSON.stringify(subjects.map((message) => ({message, parents: 1})));

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

	it.effect(
		"the #4057 stale-timeline case: PR + timeline both lag, but the base branch carries the squash ⇒ merged",
		() =>
			Effect.gen(function* () {
				const signals = yield* (yield* Github).signals(4011, REPO);
				assert.strictEqual(signals.merged, false);
				assert.strictEqual(signals.lastMergeQueueEvent, "added_to_merge_queue");
				assert.strictEqual(signals.baseBranchSquash, "landed");
				assert.strictEqual(classify(signals).outcome, "merged");
			}).pipe((effect) =>
				provide(effect, {
					prState: prView("OPEN", "QUEUED", "main"),
					timeline: timelineEvents("added_to_merge_queue"),
					baseCommits: baseCommits("fix(ship-it): a thing (#4011)", "chore: another (#4012)"),
				}),
			),
	);

	it.effect(
		"fail-closed: an unreadable base branch recovers to `unreadable`, leaving the timeline verdict",
		() =>
			Effect.gen(function* () {
				// The base-commits read exits 1 (unprovided). No evidence must never promote a verdict.
				const signals = yield* (yield* Github).signals(4011, REPO);
				assert.strictEqual(signals.baseBranchSquash, "unreadable");
				assert.strictEqual(classify(signals).outcome, "queued");
			}).pipe((effect) =>
				provide(effect, {
					prState: prView("OPEN", "QUEUED", "main"),
					timeline: timelineEvents("added_to_merge_queue"),
				}),
			),
	);

	it.effect("a merged PR skips the base-branch read entirely (nothing left to corroborate)", () =>
		Effect.gen(function* () {
			// No `baseCommits` fixture: had the read been made it would have exited 1, and the
			// undefined field is what proves it was skipped rather than recovered.
			const signals = yield* (yield* Github).signals(4011, REPO);
			assert.strictEqual(signals.baseBranchSquash, undefined);
			assert.strictEqual(classify(signals).outcome, "merged");
		}).pipe((effect) =>
			provide(effect, {
				prState: prView("MERGED", undefined, "main"),
				timeline: timelineEvents("added_to_merge_queue", "removed_from_merge_queue"),
			}),
		),
	);

	it.effect(
		"the #4155 consumed-entry case: removal + a `merged` event on a lagging PR read ⇒ not ejected",
		() =>
			Effect.gen(function* () {
				// The live #4164 timeline shape, read while `pulls/4164` still returned merged:false.
				const signals = yield* (yield* Github).signals(4164, REPO);
				assert.strictEqual(signals.lastMergeQueueEvent, "removed_from_merge_queue");
				assert.strictEqual(signals.mergedTimelineEvent, true);
				assert.notStrictEqual(classify(signals).outcome, "ejected");
			}).pipe((effect) =>
				provide(effect, {
					prState: prView("OPEN", "CLEAN", "main"),
					timeline: timelineEvents("added_to_merge_queue", "removed_from_merge_queue", "merged"),
					baseCommits: baseCommits("chore: someone else's squash (#4165)"),
				}),
			),
	);

	it.effect("fail-closed: an unreadable timeline carries NO merge evidence either", () =>
		Effect.gen(function* () {
			// The timeline read exits 1 (unprovided): a fault must not fabricate a `merged` event
			// any more than it fabricates an ejection.
			const signals = yield* (yield* Github).signals(1906, REPO);
			assert.strictEqual(signals.mergedTimelineEvent, false);
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
