import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {DIFF_AT} from "../review/fixtures.test-support.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, STALE_HEAD, ZERO_SCOPE} from "./codes.ts";
import {
	BASE,
	BASE_TIP,
	binding,
	HEAD,
	OLD_HEAD,
	pull,
	SHOW_AT,
	STATUS_AT,
	statuses,
} from "./fixtures.test-support.ts";
import {runGuards} from "./guards-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const SKILL = "claude-plugins/fabrika/skills/review/SKILL.md";

const options = {
	pr: 4321,
	sha: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runGuards({...options, ...overrides}), fakeShell(script).layer));

const diffOf = (path: string, ...body: ReadonlyArray<string>): string =>
	[
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -12,2 +12,2 @@",
		...body,
		"",
	].join("\n");

/**
 * The one changed file scripted at both commits.
 *
 * `before` defaults to `bytes` — a file whose *blocks* are identical at both ends, so a test that
 * only means to exercise the diff walk is not accidentally also asserting a block hit.
 */
const scripted = (
	diff: string,
	bytes: string,
	path = SKILL,
	before = bytes,
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull({changedFiles: 1})],
	...binding(),
	[DIFF_AT(), okOut(diff)],
	[STATUS_AT(), statuses(["M", path])],
	[SHOW_AT(HEAD, path), okOut(bytes)],
	[SHOW_AT(BASE, path), okOut(before)],
];

describe("runGuards", () => {
	it("reports a modified anchor as a hit, with the file and line", async () => {
		const out = await run(
			scripted(
				diffOf(
					SKILL,
					"-<!-- anchor: UNSEEN-NEVER-PLAUSIBLE --> an unseen surface is never plausible",
					"+<!-- anchor: UNSEEN-NEVER-PLAUSIBLE --> an unseen surface may be plausible",
				),
				"<!-- anchor: UNSEEN-NEVER-PLAUSIBLE --> an unseen surface may be plausible\n",
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[`guards\thits\t1`, `anchor\tmodified\tUNSEEN-NEVER-PLAUSIBLE\t${SKILL}:12`, ""].join("\n"),
		);
	});

	it("answers `no-anchor-change` when anchors are in reach and none moved", async () => {
		const out = await run(
			scripted(diffOf(SKILL, "-prose", "+other prose"), "<!-- anchor: G --> g\n"),
		);
		expect(out.stdout).toBe(
			[`guards\tno-anchor-change\t1`, `guard-file\t${SKILL}\t1`, ""].join("\n"),
		);
	});

	it("answers `no-anchors-in-reach` when the touched files carry none — the floor's own silence", async () => {
		const out = await run(
			scripted(
				diffOf("src/cart.ts", "-const a = 1;", "+const a = 2;"),
				"const a = 2;\n",
				"src/cart.ts",
			),
		);
		expect(out.stdout).toBe(["guards\tno-anchors-in-reach\t0", ""].join("\n"));
	});

	it("lists a touched workflow as guard-bearing even with no anchor in it", async () => {
		const path = ".github/workflows/ci.yml";
		const out = await run(scripted(diffOf(path, "-  run: a", "+  run: b"), "jobs: {}\n", path));
		expect(out.stdout).toContain(`guard-file\t${path}\t0`);
	});

	it("caps the guard-file evidence at five and counts the rest, on both channels (ADR 0308)", async () => {
		const paths = Array.from({length: 7}, (_, i) => `.github/workflows/g${i}.yml`);
		const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
			[PULL, pull({changedFiles: paths.length})],
			...binding(),
			[DIFF_AT(), okOut(paths.map((path) => diffOf(path, "-  run: a", "+  run: b")).join("\n"))],
			[STATUS_AT(), statuses(...paths.map((path) => ["M", path] as const))],
			...paths.flatMap(
				(path) =>
					[
						[SHOW_AT(HEAD, path), okOut("jobs: {}\n")],
						[SHOW_AT(BASE, path), okOut("jobs: {}\n")],
					] as ReadonlyArray<readonly [RegExp, ExecResult]>,
			),
		];

		const lines = await run(script);
		expect(lines.stdout.split("\n").filter((line) => line.startsWith("guard-file\t"))).toHaveLength(
			5,
		);
		expect(lines.stdout).toContain("guard-file-more\t2");

		const json = JSON.parse((await run(script, {json: true})).stdout);
		expect(json.guardFiles.rows).toHaveLength(5);
		expect(json.guardFiles.more).toBe(2);
	});

	it("carries `more: 0` under the cap, so a whole list never reads as a truncated one", async () => {
		const out = await run(
			scripted(diffOf(SKILL, "-prose", "+other prose"), "<!-- anchor: G --> g\n"),
			{json: true},
		);
		expect(JSON.parse(out.stdout).guardFiles).toEqual({
			rows: [{path: SKILL, anchors: 1}],
			more: 0,
		});
	});

	it("keeps a file whose anchor MOVED out of the guard-file list — it is already a hit", async () => {
		const out = await run(
			scripted(
				diffOf(SKILL, "-<!-- anchor: G --> one", "+<!-- anchor: G --> two"),
				"<!-- anchor: G --> two\n",
			),
		);
		expect(out.stdout).not.toContain("guard-file");
	});

	/**
	 * The point read #6077 found, pinned (#5770).
	 *
	 * The block comparison is a read at ONE commit, so unlike the three-dot diff around it nothing
	 * recomputes a branch point for it. Main here has edited the anchor since this branch left: at the
	 * merge base the anchor still reads `one`, which is what the head carries, and at the branch tip
	 * it reads `three`. Reading the tip would report a modification this PR did not make.
	 */
	it("compares the anchor block at the merge base, not at a main that edited it since", async () => {
		const anchored = (text: string): string => `<!-- anchor: G --> ${text}\n`;
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			...binding(),
			[DIFF_AT(), okOut(diffOf(SKILL, "-prose", "+other prose"))],
			[STATUS_AT(), statuses(["M", SKILL])],
			[SHOW_AT(HEAD, SKILL), okOut(anchored("one"))],
			[SHOW_AT(BASE, SKILL), okOut(anchored("one"))],
			[SHOW_AT(BASE_TIP, SKILL), okOut(anchored("three"))],
		]);
		expect(out.stdout).toBe(
			[`guards\tno-anchor-change\t1`, `guard-file\t${SKILL}\t1`, ""].join("\n"),
		);
	});

	it("states the scanned file count, the anchors in reach and the base comparison on stderr", async () => {
		const out = await run(scripted(diffOf(SKILL, "-a", "+b"), "<!-- anchor: G --> g\n"));
		expect(out.stderr.at(-1)).toBe(
			`governance guards: scanned 1 files, 1 anchored invariants in reach, 1 compared block-by-block against ${BASE}.`,
		);
	});

	it("emits the record with --json", async () => {
		const out = await run(scripted(diffOf(SKILL, "-<!-- anchor: G --> one"), "prose\n"), {
			json: true,
		});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "hits",
			hits: [{kind: "removed", name: "G", file: SKILL, line: 12}],
			scanned: 1,
		});
	});

	// The PR #5501 shape: not one `+`/`-` line in that 98-file diff carried an anchor tag, yet two
	// anchored paragraphs had been reworded on their continuation lines (#5514).
	it("reports a hit when the anchored PROSE changed and no anchor line is in the diff at all", async () => {
		const claim = (checkout: string): string =>
			[
				"<!-- anchor: READ-DERIVES-AGAINST-THE-PACKED-BRANCH --> **`read` re-derives against the",
				`pack's own branch.** A successor is a different checkout — usually ${checkout} sitting on`,
				"the default branch — so deriving from `HEAD` would report its own location as drift.",
				"",
			].join("\n");
		const out = await run(
			scripted(
				diffOf(
					SKILL,
					"-pack's own branch.** A successor is a different checkout — usually a fresh worktree sitting on",
					"+pack's own branch.** A successor is a different checkout — usually a fresh clone sitting on",
				),
				claim("a fresh clone"),
				SKILL,
				claim("a fresh worktree"),
			),
		);
		expect(out.stdout).toBe(
			[
				"guards\thits\t1",
				`anchor\tmodified\tREAD-DERIVES-AGAINST-THE-PACKED-BRANCH\t${SKILL}:1`,
				"",
			].join("\n"),
		);
	});

	it("still answers `no-anchor-change` when the anchored blocks are untouched — not a clearance", async () => {
		const bytes = "<!-- anchor: G --> a claim\n\nunanchored prose\n";
		const out = await run(
			scripted(diffOf(SKILL, "-unanchored prose", "+other unanchored prose"), bytes, SKILL, bytes),
		);
		expect(out.stdout).toBe(
			[`guards\tno-anchor-change\t1`, `guard-file\t${SKILL}\t1`, ""].join("\n"),
		);
	});

	it("counts one hit per anchor when both scans see it — the two scans are not two findings", async () => {
		const out = await run(
			scripted(
				diffOf(SKILL, "-<!-- anchor: G --> one", "+<!-- anchor: G --> two"),
				"<!-- anchor: G --> two\n",
				SKILL,
				"<!-- anchor: G --> one\n",
			),
		);
		expect(out.stdout).toBe([`guards\thits\t1`, `anchor\tmodified\tG\t${SKILL}:12`, ""].join("\n"));
	});

	it("refuses an unreadable BASE read on 11 — UNKNOWN, never `nothing moved`", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			...binding(),
			[DIFF_AT(), okOut(diffOf(SKILL, "-a", "+b"))],
			[STATUS_AT(), statuses(["M", SKILL])],
			[SHOW_AT(HEAD, SKILL), okOut("<!-- anchor: G --> g\n")],
			[SHOW_AT(BASE, SKILL), errOut("fatal: path does not exist")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`governance guards: cannot read ${SKILL} at ${BASE}: fatal: path does not exist — UNKNOWN, never "nothing moved".`,
		);
	});

	it("does NOT read an added file at the base — it has no base side to compare", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			...binding(),
			[DIFF_AT(), okOut(diffOf(SKILL, "+<!-- anchor: G --> a claim"))],
			[STATUS_AT(), statuses(["A", SKILL])],
			[SHOW_AT(HEAD, SKILL), okOut("<!-- anchor: G --> a claim\n")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[`guards\tno-anchor-change\t1`, `guard-file\t${SKILL}\t1`, ""].join("\n"),
		);
	});

	it("reports a deleted file's anchors as removed — the walk still covers what has no head bytes", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			...binding(),
			[DIFF_AT(), okOut(diffOf(SKILL, "-<!-- anchor: G --> a claim"))],
			[STATUS_AT(), statuses(["D", SKILL])],
		]);
		expect(out.stdout).toBe([`guards\thits\t0`, `anchor\tremoved\tG\t${SKILL}:12`, ""].join("\n"));
	});

	it("refuses an absent, closed, or empty PR on 7", async () => {
		expect((await run([[PULL, errOut("gh: Not Found (HTTP 404)")]])).code).toBe(ZERO_SCOPE);
		expect((await run([[PULL, pull({state: "closed"})]])).code).toBe(ZERO_SCOPE);
		expect((await run([[PULL, pull({changedFiles: 0})]])).code).toBe(ZERO_SCOPE);
	});

	it("refuses an unreadable diff on 11 — UNKNOWN, never `nothing moved`", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			...binding(),
			[DIFF_AT(), errOut("fatal: bad revision")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('UNKNOWN, never "nothing moved"');
	});

	it("refuses a partial diff on 13 rather than scanning it", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 4})],
			...binding(),
			[DIFF_AT(), okOut(diffOf(SKILL, "-a", "+b"))],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`governance guards: the diff at ${HEAD} carries 1 of #4321's 4 declared files — refusing a partial anchor scan (#3925's class).`,
		);
	});

	it("refuses a --sha that is not the PR's head on 12", async () => {
		expect((await run(scripted(diffOf(SKILL, "-a", "+b"), "x\n"), {sha: OLD_HEAD})).code).toBe(
			STALE_HEAD,
		);
	});
});
