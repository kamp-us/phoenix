import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {DIFF_AT} from "../review/fixtures.test-support.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, STALE_HEAD, ZERO_SCOPE} from "./codes.ts";
import {
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

const scripted = (
	diff: string,
	bytes: string,
	path = SKILL,
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull({changedFiles: 1})],
	...binding(),
	[DIFF_AT(), okOut(diff)],
	[STATUS_AT(), statuses(["M", path])],
	[SHOW_AT(HEAD, path), okOut(bytes)],
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

	it("keeps a file whose anchor MOVED out of the guard-file list — it is already a hit", async () => {
		const out = await run(
			scripted(
				diffOf(SKILL, "-<!-- anchor: G --> one", "+<!-- anchor: G --> two"),
				"<!-- anchor: G --> two\n",
			),
		);
		expect(out.stdout).not.toContain("guard-file");
	});

	it("states the scanned file count and the anchors in reach on stderr", async () => {
		const out = await run(scripted(diffOf(SKILL, "-a", "+b"), "<!-- anchor: G --> g\n"));
		expect(out.stderr.at(-1)).toBe(
			"governance guards: scanned 1 files, 1 anchored invariants in reach.",
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
