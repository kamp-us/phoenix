/**
 * The proof that editing an authored program costs the desk nothing (#8735): the worked `pr-review`
 * example, driven on a real kernel, through the reload and restore path that already exists —
 * `../../reload.ts` and `../../durability/`, neither of them touched by this change.
 *
 * Three runs over `fixtures/reviewing-desk.ts`, whose generation is a JSON file this test rewrites
 * between boots so a second load is a genuinely different config (`../../reload-proof.unit.test.ts`
 * is the shape). Run one drives a review to a verdict and re-reads a config naming another pull
 * request: the live process takes it through the spread `configChanged` and keeps the verdict it
 * already had. Run two boots the same project back and reads the restored state, then drives a
 * second review to prove the graph wired its `verdict` route again. Run three is the same project a
 * third time under a generation whose reviewer's `resume` emits: a restored spawned child's ports
 * are un-wired, so that emit fails `PortNotWired` naming the port, loudly, and the boot refuses.
 *
 * Every wait is bounded and says what it was waiting for
 * (`.patterns/ci-legible-integration-tests.md`).
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert} from "@effect/vitest";
import {Cause, Effect, Exit, type FileSystem, Option, type Scope} from "effect";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {type Booted, boot, projectDir} from "../../boot.ts";
import {Processes} from "../../process/Processes.ts";
import {type ProcessHandle, ProcessId} from "../../process/process.ts";
import {
	DESK_NODE,
	type DeclaredReview,
	FIXTURE_VAR,
	REVIEW_NODE,
	REVIEWER_PROGRAM,
	SINK_NODE,
	VERDICT,
} from "./fixtures/names.ts";

const configModule = fileURLToPath(new URL("./fixtures/reviewing-desk.ts", import.meta.url));

const FIRST_PR = 8735;
const RELOADED_PR = 8716;
const SECOND_BOOT_PR = 8923;

const tempDirs: string[] = [];

const freshDir = (prefix: string): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
};

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
	delete process.env[FIXTURE_VAR];
});

const declare = (path: string, generation: DeclaredReview): void =>
	writeFileSync(path, JSON.stringify(generation));

/** What the example's process is holding: the pull request it is on, and the verdict it announced. */
interface ReviewState {
	readonly pr: number | null;
	readonly verdict: string | null;
}

const stateOf = <S>(handle: ProcessHandle): S => handle.getState() as S;

const until = (what: string, check: () => boolean, seen: () => unknown, attempts = 1_000) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < attempts && !check(); attempt += 1) {
			yield* Effect.sleep("10 millis");
		}
		assert.isTrue(check(), `timed out waiting for ${what}; last saw ${JSON.stringify(seen())}`);
	});

const nodes = (booted: Booted) =>
	Effect.gen(function* () {
		const processes = yield* Processes;
		const node = Effect.fnUntraced(function* (id: string) {
			const handle = yield* processes.handle(ProcessId.make(id));
			assert.isTrue(Option.isSome(handle), `the config's ${id} node did not launch`);
			return Option.getOrThrow(handle);
		});
		return {
			desk: yield* node(DESK_NODE),
			review: yield* node(REVIEW_NODE),
			sink: yield* node(SINK_NODE),
		};
	}).pipe(Effect.provideContext(booted.kernel));

/**
 * One whole review, and the example composes all of it: the desk emits onto `pr`, the example
 * spawns the reviewer, its own `spawned` cell puts the prompt on the child's `prompt` port (#8888),
 * and the verdict comes back. Nothing outside this program asks the reviewer anything — the prompt
 * used to be sent from here with the kernel's own `send`, because the example had no cell for the
 * `spawned` answer and so had no moment at which it knew the child's id.
 */
const review = (desk: ProcessHandle, target: ProcessHandle, pr: number) =>
	Effect.gen(function* () {
		const seen = () => stateOf<ReviewState>(target);
		yield* desk.dispatch({type: "say", pr});
		yield* until(`the pull request to reach the example`, () => seen().pr === pr, seen);
		yield* until("the reviewer's verdict to come back", () => seen().verdict === VERDICT, seen);
	});

interface FirstRun {
	readonly beforeReload: ReviewState;
	readonly notified: number;
	readonly afterReload: ReviewState;
	readonly heard: ReadonlyArray<string>;
}

/**
 * Drive one review, then re-read a config naming another pull request. Nothing restarts: the live
 * process is handed what its own row says the change means for it, and keeps everything else.
 */
const runFirstBoot = (
	project: string,
	declaration: string,
): Effect.Effect<FirstRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project});
		const {desk, review: target, sink} = yield* nodes(booted);
		yield* review(desk, target, FIRST_PR);
		const beforeReload = stateOf<ReviewState>(target);

		declare(declaration, {reviewing: RELOADED_PR, resumeEmits: false});
		const report = yield* booted.reload;
		yield* until(
			"the re-read config to reach the live process",
			() => stateOf<ReviewState>(target).pr === RELOADED_PR,
			() => stateOf<ReviewState>(target),
		);

		return {
			beforeReload,
			notified: report.notified,
			afterReload: stateOf<ReviewState>(target),
			heard: stateOf<{readonly heard: ReadonlyArray<string>}>(sink).heard,
		} satisfies FirstRun;
	}).pipe(Effect.scoped);

interface SecondRun {
	readonly restoredCount: number;
	readonly restored: ReviewState;
	readonly heardOnArrival: ReadonlyArray<string>;
	readonly heardAfterSecondReview: ReadonlyArray<string>;
}

/** Boot the same project back over its checkpoints and drive a second review through the route. */
const runFromTheCheckpoint = (
	project: string,
): Effect.Effect<SecondRun, unknown, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const booted = yield* boot({global: configModule, project});
		const {desk, review: target, sink} = yield* nodes(booted);
		const restored = stateOf<ReviewState>(target);
		const heardOnArrival = stateOf<{readonly heard: ReadonlyArray<string>}>(sink).heard;

		yield* desk.dispatch({type: "say", pr: SECOND_BOOT_PR});
		yield* until(
			"the restored example to take a fresh pull request",
			() => stateOf<ReviewState>(target).pr === SECOND_BOOT_PR,
			() => stateOf<ReviewState>(target),
		);
		yield* until(
			"the restored example's `verdict` route to reach the sink",
			() =>
				stateOf<{readonly heard: ReadonlyArray<string>}>(sink).heard.length > heardOnArrival.length,
			() => stateOf<{readonly heard: ReadonlyArray<string>}>(sink).heard,
		);

		return {
			restoredCount: booted.report.restoredCount,
			restored,
			heardOnArrival,
			heardAfterSecondReview: stateOf<{readonly heard: ReadonlyArray<string>}>(sink).heard,
		} satisfies SecondRun;
	}).pipe(Effect.scoped);

/**
 * The same project once more, under a generation whose reviewer resumes by announcing its verdict.
 * The reviewer is a spawned child, not a graph node, so `restore` hands it un-wired ports — the
 * emit is refused rather than dropped, and the refusal names the port.
 */
const runWithAResumeThatEmits = (
	project: string,
	declaration: string,
): Effect.Effect<Exit.Exit<unknown, unknown>, never, FileSystem.FileSystem> => {
	declare(declaration, {reviewing: RELOADED_PR, resumeEmits: true});
	return Effect.exit(boot({global: configModule, project}).pipe(Effect.scoped));
};

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

const proof = Effect.fnUntraced(function* () {
	const project = freshDir("tuval-authoring-reload-");
	mkdirSync(projectDir(project));
	const declaration = join(freshDir("tuval-authoring-declared-"), "config.json");
	declare(declaration, {reviewing: FIRST_PR, resumeEmits: false});
	process.env[FIXTURE_VAR] = declaration;

	const first = yield* runFirstBoot(project, declaration);
	const second = yield* runFromTheCheckpoint(project);
	const third = yield* runWithAResumeThatEmits(project, declaration);
	return {first, second, third};
});

let outcome: {
	readonly first: FirstRun;
	readonly second: SecondRun;
	readonly third: Exit.Exit<unknown, unknown>;
};

beforeAll(async () => {
	outcome = await Effect.runPromise(run(proof()));
}, 120_000);

describe("an authored program under a config re-read", () => {
	it("keeps the state it had, and takes only what the new config said", () => {
		expect(outcome.first.beforeReload).toEqual({pr: FIRST_PR, verdict: VERDICT});
		expect(
			outcome.first.afterReload.verdict,
			"the re-read config reset the verdict the process had already announced",
		).toBe(VERDICT);
		expect(outcome.first.afterReload.pr).toBe(RELOADED_PR);
	});

	it("reaches the live process through the row's own `configChanged`, not a restart", () => {
		expect(
			outcome.first.notified,
			"the reload told no live process, so the change never left the config",
		).toBe(1);
		expect(
			outcome.first.heard,
			"the example's `verdict` route did not reach the reader on the other end",
		).toEqual([VERDICT]);
	});
});

describe("an authored program brought back from its checkpoint", () => {
	it("restores the state its process was holding", () => {
		expect(
			outcome.second.restoredCount,
			"the second boot did not bring the graph's processes back from their checkpoints",
		).toBeGreaterThanOrEqual(3);
		expect(outcome.second.restored).toEqual({pr: RELOADED_PR, verdict: VERDICT});
		expect(
			outcome.second.heardOnArrival,
			"the reader came back without what it had already heard",
		).toEqual([VERDICT]);
	});

	it("has its ports wired again, so what it emits reaches the route the graph plans", () => {
		expect(outcome.second.heardAfterSecondReview).toEqual([VERDICT, VERDICT]);
	});
});

describe("a restored process the graph does not plan", () => {
	it("fails its emit loudly with the port named, rather than dropping the payload", () => {
		assert.isTrue(
			Exit.isFailure(outcome.third),
			"a restored spawned child emitted onto un-wired ports and the boot went on regardless",
		);
		const failure = Exit.isFailure(outcome.third)
			? (Cause.squash(outcome.third.cause) as {
					readonly _tag?: string;
					readonly programId?: string;
					readonly cause?: {readonly _tag?: string; readonly port?: string};
				})
			: undefined;
		expect(failure?._tag).toBe("tuval/HandlerFailed");
		expect(failure?.programId).toBe(REVIEWER_PROGRAM);
		expect(failure?.cause?._tag).toBe("tuval/ports/PortNotWired");
		expect(failure?.cause?.port, "the refusal did not name the port that was not wired").toBe(
			"result",
		);
	});
});
