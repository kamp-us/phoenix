/**
 * `lane dispatch`'s pre-dispatch refresh — the assembly branch moves onto trunk before a child's
 * worktree is cut from it, and a repo that declared nothing keeps the dispatch path it has today.
 */
import {Effect, type FileSystem, Layer, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {describe, expect, it} from "vitest";
import type {EntrypointRead} from "../delegate/entrypoint.ts";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {MERGE_CONFLICT, NO_SHELL} from "./codes.ts";
import {type DispatchOptions, runDispatch} from "./dispatch-verb.ts";
import {emitMachine} from "./emit.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {REFRESH_PARK_CAUSE, type RefreshOptions, runRefresh} from "./refresh-verb.ts";

const ROOT = ".fabrika/lanes";
const EPIC = 5800;
const CHILD = 5828;
const CWD = "/repo";
const SEAT = "/repo/.claude/worktrees/epic-5800";
const BEFORE = "aaaa111";
const AFTER = "bbbb222";
const TIP = "cccc333";

const LIST = /^git worktree list --porcelain$/;
const HEAD = /^git -C .* rev-parse HEAD$/;
const STATUS = /^git -C .* status --porcelain --untracked-files=no$/;
const FETCH = /^git -C .* fetch --quiet origin$/;
const RESOLVE = /^git -C .* rev-parse --verify origin\/main\^\{commit\}$/;
const CARRIED = /^git -C .* merge-base --is-ancestor /;
const MERGE = /^git -C .* merge --no-edit --no-ff /;
const ABORT = /^git -C .* merge --abort$/;
const RESET = /^git -C .* reset --hard ORIG_HEAD$/;

const SEATED: ExecResult = okOut(
	[
		`worktree ${CWD}\nHEAD ${BEFORE}\nbranch refs/heads/main\n`,
		`worktree ${SEAT}\nHEAD ${BEFORE}\nbranch refs/heads/epic/${EPIC}\n`,
	].join("\n"),
);

/** The reads a merging run makes before `git merge`, ending on "the branch does not carry trunk". */
const upToMerge = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[LIST, SEATED],
	[once(HEAD), okOut(BEFORE)],
	[once(STATUS), okOut("")],
	[FETCH, okOut("")],
	[RESOLVE, okOut(TIP)],
	[CARRIED, errOut("not an ancestor")],
];

const emitted = () => {
	const machine = emitMachine(EPIC, `## Dependencies\n\n- phase 1: #${CHILD}\n`, [
		{number: CHILD, state: "open", stateReason: null, classes: []},
	]);
	if (machine._tag !== "Emitted") throw new Error(`the epic fixture did not emit: ${machine._tag}`);
	return machine.text;
};

const laneFiles = (declared: string | null) => ({
	[`${ROOT}/8617/workflow.json`]: coderTemplateText(),
	[`${ROOT}/${EPIC}/workflow.json`]: emitted(),
	[`${ROOT}/${EPIC}/events.jsonl`]: `${JSON.stringify({
		task: `issue_${CHILD}`,
		event: `ISSUE_${CHILD}.WIP`,
		at: "2026-09-09T00:00:00Z",
	})}\n`,
	...(declared === null ? {} : {[`${CWD}/.fabrika.jsonc`]: declared}),
});

const options: DispatchOptions = {
	root: ROOT,
	lane: String(EPIC),
	task: `issue_${CHILD}`,
	repo: null,
	env: {CODEX_THREAD_ID: "codex-thread"},
	entrypoint: {_tag: "Entrypoint", entrypoint: "packages/fabrika-cli/src/bin.ts"} as EntrypointRead,
	cwd: CWD,
	harness: "codex",
	skills: "/skills",
	worktree: "/scratch/child-5828",
};

/**
 * The brief is where each case stops: what is under test is everything before it, so the stub
 * records that it was reached and refuses rather than sending the run on into a worktree.
 */
const run = (
	declared: string | null,
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	refresh: (
		options: RefreshOptions,
	) => Effect.Effect<
		VerbOutcome,
		never,
		ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
	> = runRefresh,
) => {
	const shell = fakeShell(script);
	const reached: string[] = [];
	return Effect.runPromise(
		Effect.provide(
			runDispatch(
				options,
				() => {
					reached.push("brief");
					return Effect.succeed(refuse(NO_SHELL, "stopped at the brief"));
				},
				() => Effect.succeed(answer("unused")),
				(refreshOptions) => {
					reached.push("refresh");
					return refresh(refreshOptions);
				},
			),
			Layer.merge(shell.layer, fakeFs({files: laneFiles(declared)}).layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls, reached}));
};

describe("the pre-dispatch assembly refresh", () => {
	it("merges the trunk into the assembly branch before the brief is emitted", async () => {
		const {outcome, calls, reached} = await run('{"assemblyRefresh":{"onDispatch":"on"}}', [
			...upToMerge(),
			[MERGE, okOut("")],
			[HEAD, okOut(AFTER)],
		]);

		expect(reached).toEqual(["refresh", "brief"]);
		expect(calls).toContain(`git -C ${SEAT} merge --no-edit --no-ff ${TIP}`);
		expect(outcome.code).toBe(NO_SHELL);
	});

	it("merges nothing under the shipped key, so the dispatch path is the one it has today", async () => {
		const {outcome, calls, reached} = await run(null, []);

		expect(reached).toEqual(["refresh", "brief"]);
		expect(calls).toEqual([]);
		expect(outcome.code).toBe(NO_SHELL);
	});

	it("relays a conflict as the park it names, and no shell is briefed over the stale branch", async () => {
		const {outcome, calls, reached} = await run('{"assemblyRefresh":{"onDispatch":"on"}}', [
			...upToMerge(),
			[MERGE, errOut("CONFLICT (content): Merge conflict in src/lane/report.ts")],
			[ABORT, okOut("")],
			[RESET, okOut("")],
			[HEAD, okOut(BEFORE)],
		]);

		expect(outcome.code).toBe(MERGE_CONFLICT);
		expect(outcome.stderr.join("\n")).toContain(REFRESH_PARK_CAUSE);
		expect(reached).toEqual(["refresh"]);
		expect(calls.some((call) => call.includes("worktree add"))).toBe(false);
	});

	it("refreshes nothing on a single-issue lane, which owns no assembly branch", async () => {
		const single = {...options, lane: "8617", task: "issue"};
		const shell = fakeShell([]);
		const reached: string[] = [];
		const outcome = await Effect.runPromise(
			Effect.provide(
				runDispatch(
					single,
					() => Effect.succeed(refuse(NO_SHELL, "stopped at the brief")),
					() => Effect.succeed(answer("unused")),
					() => {
						reached.push("refresh");
						return Effect.succeed(answer(""));
					},
				),
				Layer.merge(shell.layer, fakeFs({files: laneFiles(null)}).layer),
			),
		);

		expect(reached).toEqual([]);
		expect(outcome.code).toBe(NO_SHELL);
	});
});
