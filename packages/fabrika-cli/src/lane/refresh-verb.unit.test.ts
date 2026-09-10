/**
 * `lane refresh` — the assembly branch moves onto trunk, and every refusal leaves it proven back at
 * the head the merge found.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import type {AssemblyRefreshSurface} from "../config/keys/assembly-refresh.ts";
import type {Read} from "../config/read-key.ts";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	APPEND_UNKNOWN,
	ASSEMBLY_DIRTY,
	ASSEMBLY_UNSEATED,
	KEY_MALFORMED,
	LANE_UNREADABLE,
	MERGE_CONFLICT,
	PRIMARY_CHECKOUT,
	PROOF_ABSENT,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {REFRESH_PARK_CAUSE, runRefresh} from "./refresh-verb.ts";

const ROOT = ".fabrika/lanes";
const EPIC = 8810;
const BRANCH = `epic/${EPIC}`;
const BASE = "origin/main";
const MAIN = "/checkout/repo";
const SEAT = `${MAIN}/.claude/worktrees/epic-${EPIC}`;
const BEFORE = "aaaa111";
const AFTER = "bbbb222";
const TIP = "cccc333";

const LANE_FILES = {[`${ROOT}/${EPIC}/workflow.json`]: coderTemplateText()};

const LIST = /^git worktree list --porcelain$/;
const HEAD = /^git -C .* rev-parse HEAD$/;
const STATUS = /^git -C .* status --porcelain --untracked-files=no$/;
const FETCH = /^git -C .* fetch --quiet origin$/;
const RESOLVE = /^git -C .* rev-parse --verify origin\/main\^\{commit\}$/;
const CARRIED = /^git -C .* merge-base --is-ancestor /;
const MERGE = /^git -C .* merge --no-edit --no-ff /;
const ABORT = /^git -C .* merge --abort$/;
const RESET = /^git -C .* reset --hard ORIG_HEAD$/;

const listing = (...blocks: ReadonlyArray<readonly [string, string]>): ExecResult =>
	okOut(
		blocks
			.map(([path, branch]) => `worktree ${path}\nHEAD ${BEFORE}\nbranch refs/heads/${branch}\n`)
			.join("\n"),
	);

const SEATED = listing([MAIN, "main"], [SEAT, BRANCH]);
const UNSEATED = listing([MAIN, "main"]);
const CONSCRIPTED = listing([MAIN, BRANCH]);

const ON: Read<AssemblyRefreshSurface> = {
	_tag: "Value",
	value: {onReview: "on"},
	note: "`assemblyRefresh` as declared in .fabrika.jsonc",
};
const OFF: Read<AssemblyRefreshSurface> = {
	_tag: "Value",
	value: {onReview: "off"},
	note: "the shipped `assemblyRefresh`",
};

/**
 * The reads every merging run makes before `git merge`: the seat, the pre-merge head, the proof the
 * seat was clean, the fetch, the trunk's commit, and the answer that the branch does not carry it.
 *
 * A function rather than a constant because `once` carries its spent flag on the regex it returns,
 * so one shared array would answer a later head read with the pre-merge entry.
 */
const upToMerge = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[LIST, SEATED],
	[once(HEAD), okOut(BEFORE)],
	[once(STATUS), okOut("")],
	[FETCH, okOut("")],
	[RESOLVE, okOut(TIP)],
	[CARRIED, errOut("not an ancestor")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	options: {readonly onReview?: boolean; readonly key?: Read<AssemblyRefreshSurface>} = {},
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runRefresh({
				epic: EPIC,
				base: BASE,
				onReview: options.onReview ?? false,
				assemblyRefresh: options.key ?? ON,
				root: ROOT,
				lane: String(EPIC),
			}),
			Layer.merge(shell.layer, fakeFs({files: LANE_FILES}).layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runRefresh", () => {
	it("merges the trunk in and answers the head it re-read, not the one it merged onto", async () => {
		const {outcome, calls} = await run([...upToMerge(), [MERGE, okOut("")], [HEAD, okOut(AFTER)]]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim().split("\n")).toEqual([AFTER, "REFRESH-VERDICT: MERGED"]);
		expect(calls).toContain(`git -C ${SEAT} merge --no-edit --no-ff ${TIP}`);
		// The trunk is resolved to a commit after the fetch, so the merge names a sha and not a ref
		// whose meaning the fetch just changed.
		expect(calls).toContain(`git -C ${SEAT} rev-parse --verify ${BASE}^{commit}`);
	});

	it("is silent and merges nothing when the branch already carries the trunk", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[once(HEAD), okOut(BEFORE)],
			[once(STATUS), okOut("")],
			[FETCH, okOut("")],
			[RESOLVE, okOut(TIP)],
			[CARRIED, okOut("")],
		]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim().split("\n")).toEqual([BEFORE, "REFRESH-VERDICT: CURRENT"]);
		expect(calls.some((line) => line.includes(" merge --no-edit"))).toBe(false);
	});

	it("aborts a conflict, proves the branch back at its pre-merge head, and names the park cause", async () => {
		const {outcome, calls} = await run([
			...upToMerge(),
			[MERGE, errOut("CONFLICT (content): Merge conflict in src/lane/report.ts")],
			[ABORT, okOut("")],
			[RESET, okOut("")],
			[HEAD, okOut(BEFORE)],
		]);

		expect(outcome.code).toBe(MERGE_CONFLICT);
		expect(calls).toContain(`git -C ${SEAT} merge --abort`);
		expect(calls).toContain(`git -C ${SEAT} reset --hard ORIG_HEAD`);
		expect(outcome.stderr.join("\n")).toContain(`--cause ${REFRESH_PARK_CAUSE}`);
		expect(outcome.stderr.join("\n")).toContain(`reset ${SEAT} back to ${BEFORE}`);
		expect(outcome.stderr.join("\n")).toContain("CONFLICT (content)");
	});

	it("reports a restore that did not take as UNKNOWN, never as the clean conflict refusal", async () => {
		const {outcome} = await run([
			...upToMerge(),
			[MERGE, errOut("CONFLICT (content): Merge conflict in src/lane/report.ts")],
			[ABORT, errOut("fatal: There is no merge to abort")],
			[RESET, errOut("fatal: could not reset")],
			[HEAD, okOut(AFTER)],
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("it was NOT restored");
	});

	it("reports an unreadable head after the restore as UNKNOWN too", async () => {
		const {outcome} = await run([
			...upToMerge(),
			[MERGE, errOut("CONFLICT")],
			[ABORT, okOut("")],
			[RESET, okOut("")],
			[HEAD, errOut("fatal: not a git repository")],
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("refuses a merge that reported success and did not move the head", async () => {
		const {outcome} = await run([...upToMerge(), [MERGE, okOut("")], [HEAD, okOut(BEFORE)]]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("never a silent pass");
	});

	it("refuses a dirty seat before it fetches anything, with the same code lane integrate uses", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[once(HEAD), okOut(BEFORE)],
			[once(STATUS), okOut(" M src/lane/report.ts")],
		]);

		expect(outcome.code).toBe(ASSEMBLY_DIRTY);
		expect(calls.some((line) => line.includes("fetch"))).toBe(false);
	});

	it("refuses the driver's own checkout, with the same code lane integrate uses", async () => {
		const {outcome} = await run([[LIST, CONSCRIPTED]]);

		expect(outcome.code).toBe(PRIMARY_CHECKOUT);
	});

	it("refuses an unseated assembly, with the same code lane integrate uses", async () => {
		const {outcome} = await run([[LIST, UNSEATED]]);

		expect(outcome.code).toBe(ASSEMBLY_UNSEATED);
	});

	it("is UNKNOWN when the fetch fails, and merges nothing", async () => {
		const {outcome, calls} = await run([
			[LIST, SEATED],
			[once(HEAD), okOut(BEFORE)],
			[once(STATUS), okOut("")],
			[FETCH, errOut("fatal: could not read from remote")],
		]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(calls.some((line) => line.includes(" merge --no-edit"))).toBe(false);
	});

	it("refuses a --base that names no commit after the fetch", async () => {
		const {outcome} = await run([
			[LIST, SEATED],
			[once(HEAD), okOut(BEFORE)],
			[once(STATUS), okOut("")],
			[FETCH, okOut("")],
			[RESOLVE, errOut("fatal: Needed a single revision")],
		]);

		expect(outcome.code).toBe(PROOF_ABSENT);
	});

	it("declines the automatic call under the shipped key, reading nothing at all", async () => {
		const {outcome, calls} = await run([], {onReview: true, key: OFF});

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim()).toBe("REFRESH-VERDICT: DECLINED");
		expect(calls).toEqual([]);
	});

	it("performs the automatic call under a repo that declared it on", async () => {
		const {outcome} = await run([...upToMerge(), [MERGE, okOut("")], [HEAD, okOut(AFTER)]], {
			onReview: true,
			key: ON,
		});

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim().split("\n").at(-1)).toBe("REFRESH-VERDICT: MERGED");
	});

	it("is never gated when a driver calls it by hand, whatever the key reads", async () => {
		const {outcome} = await run([...upToMerge(), [MERGE, okOut("")], [HEAD, okOut(AFTER)]], {
			onReview: false,
			key: OFF,
		});

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trim().split("\n").at(-1)).toBe("REFRESH-VERDICT: MERGED");
	});

	it("refuses a malformed key as UNKNOWN rather than falling back to the shipped default", async () => {
		const {outcome, calls} = await run([], {
			onReview: true,
			key: {_tag: "Refused", reason: "`assemblyRefresh`'s `onReview` is not one of off, on"},
		});

		expect(outcome.code).toBe(KEY_MALFORMED);
		expect(calls).toEqual([]);
	});
});
