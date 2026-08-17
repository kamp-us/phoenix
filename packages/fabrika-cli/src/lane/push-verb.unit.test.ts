/** `lane push` — the assembly branch is derived, the push is proven, and no force path exists. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {HEAD, OLD_HEAD} from "../build/fixtures.test-support.ts";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	APPEND_UNKNOWN,
	LANE_ABSENT,
	LANE_UNREADABLE,
	REF_NOT_MOVED,
	UNSAFE_PUSH,
	WRONG_BRANCH,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {runPush} from "./push-verb.ts";

const ROOT = ".fabrika/lanes";
const EPIC = 5680;
const BRANCH = `epic/${EPIC}`;
const LANE_FILES = {[`${ROOT}/${EPIC}/workflow.json`]: coderTemplateText()};

const CURRENT_BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const HEAD_SHA = /^git rev-parse HEAD$/;
const UPSTREAM = /^git rev-parse --abbrev-ref --symbolic-full-name /;
const PRESENT = /^git rev-parse --verify --quiet /;
const LS_REMOTE = /^git ls-remote origin /;
const PUSH = /^git push /;
const ANCESTOR = /^git merge-base --is-ancestor /;
const LOG = /^git log /;

/** `git ls-remote` output for the assembly ref; an absent ref prints nothing. */
const refRow = (sha: string | null): ExecResult =>
	okOut(sha === null ? "" : `${sha}\trefs/heads/${BRANCH}\n`);

/**
 * The two `ls-remote` reads one run makes, in order: the head before the push, then the read-back.
 * They are the same command line, so the first entry is spent by {@link once}.
 */
const remote = (
	before: ExecResult,
	after: ExecResult,
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[once(LS_REMOTE), before],
	[LS_REMOTE, after],
];

/** On the assembly branch, at HEAD, with a remote head this checkout holds and contains. */
const GROUND: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[CURRENT_BRANCH, okOut(`${BRANCH}\n`)],
	[HEAD_SHA, okOut(`${HEAD}\n`)],
	[UPSTREAM, errOut("fatal: no upstream")],
	[PRESENT, okOut(`${OLD_HEAD}\n`)],
	[ANCESTOR, okOut("")],
	[PUSH, okOut("")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	files: Record<string, string> = LANE_FILES,
) => {
	const shell = fakeShell(script);
	return Effect.runPromise(
		Effect.provide(
			runPush({epic: EPIC, root: ROOT, lane: String(EPIC)}),
			Layer.merge(shell.layer, fakeFs({files}).layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

const pushed = (calls: ReadonlyArray<string>): boolean =>
	calls.some((line) => line.startsWith("git push"));

describe("runPush", () => {
	it("pushes the derived assembly branch and reports MOVED once the remote reads back at HEAD", async () => {
		const {outcome, calls} = await run([...remote(refRow(OLD_HEAD), refRow(HEAD)), ...GROUND]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout.trimEnd().split("\n").at(-1)).toBe("PUSH-VERDICT: MOVED");
		expect(calls).toContain(`git push origin HEAD:refs/heads/${BRANCH}`);
	});

	it("publishes a branch the remote does not carry yet, with no containment to prove", async () => {
		const {outcome, calls} = await run([...remote(refRow(null), refRow(HEAD)), ...GROUND]);

		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain(`remote ref read back: ${HEAD}`);
		expect(calls.some((line) => line.startsWith("git merge-base"))).toBe(false);
	});

	it("refuses a checked-out branch that is not this epic's assembly branch, pushing nothing", async () => {
		const {outcome, calls} = await run([
			[CURRENT_BRANCH, okOut("build/5729-child-a1b2c3d4\n")],
			...remote(refRow(OLD_HEAD), refRow(HEAD)),
			...GROUND,
		]);

		expect(outcome.code).toBe(WRONG_BRANCH);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(BRANCH);
		expect(pushed(calls)).toBe(false);
	});

	it("refuses a detached HEAD as a wrong branch, not as an unreadable tree", async () => {
		const {outcome, calls} = await run([
			[CURRENT_BRANCH, okOut("HEAD\n")],
			...remote(refRow(OLD_HEAD), refRow(HEAD)),
			...GROUND,
		]);

		expect(outcome.code).toBe(WRONG_BRANCH);
		expect(outcome.stderr.join("\n")).toContain("detached");
		expect(pushed(calls)).toBe(false);
	});

	it("refuses a push that would drop the published assembly head, naming the commits", async () => {
		const {outcome, calls} = await run([
			[ANCESTOR, errOut("not an ancestor")],
			[LOG, okOut("deadbee land child #5729\n")],
			...remote(refRow(OLD_HEAD), refRow(HEAD)),
			...GROUND,
		]);

		expect(outcome.code).toBe(UNSAFE_PUSH);
		expect(outcome.stderr.join("\n")).toContain("land child #5729");
		expect(pushed(calls)).toBe(false);
	});

	it("reports a proven not-moved ref rather than reading the push's own exit as evidence", async () => {
		const {outcome, calls} = await run([...remote(refRow(OLD_HEAD), refRow(OLD_HEAD)), ...GROUND]);

		expect(outcome.code).toBe(REF_NOT_MOVED);
		expect(outcome.stdout).toBe("");
		expect(pushed(calls)).toBe(true);
	});

	it("reports UNKNOWN, never MOVED, when the ref cannot be re-read after the push", async () => {
		const {outcome} = await run([
			...remote(refRow(OLD_HEAD), errOut("network is unreachable")),
			...GROUND,
		]);

		expect(outcome.code).toBe(APPEND_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("refuses an unreadable remote before pushing anything", async () => {
		const {outcome, calls} = await run([[LS_REMOTE, errOut("network is unreachable")], ...GROUND]);

		expect(outcome.code).toBe(LANE_UNREADABLE);
		expect(pushed(calls)).toBe(false);
	});

	it("refuses an epic whose lane was never emitted — a branch name alone proves nothing", async () => {
		const {outcome, calls} = await run([...remote(refRow(OLD_HEAD), refRow(HEAD)), ...GROUND], {});

		expect(outcome.code).toBe(LANE_ABSENT);
		expect(calls).toEqual([]);
	});
});
