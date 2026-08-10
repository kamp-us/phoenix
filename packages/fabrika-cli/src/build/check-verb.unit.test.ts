import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {classifyDiff, runCheck, surfaceMismatch} from "./check-verb.ts";
import {
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	UNCLASSIFIED_DIFF,
	VALIDATION_RED,
	WRONG_LANE,
	ZERO_SCOPE,
} from "./codes.ts";
import {comments, HEAD, issue, LANE_UUID, LINKED, marker, NONCE} from "./fixtures.test-support.ts";

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;
const REPO_META = /^gh api repos\/o\/r --jq \.default_branch$/;
const MERGE_BASE = /^git merge-base HEAD origin\/main$/;
const DIFF = /^git diff --name-only /;
const TYPECHECK = /^pnpm typecheck --force$/;
const LINT = /^pnpm lint:worktree$/;

const LANE = `build/4312-editor-focus-loss-${NONCE}`;

const LANE_OK: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, LINKED],
	[BRANCH, okOut(`${LANE}\n`)],
	[ISSUE, issue()],
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, okOut("write\n")],
	[REPO_META, okOut("main\n")],
	[MERGE_BASE, okOut(`${HEAD}\n`)],
];

const options = {
	surface: "code",
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
	files: Record<string, string> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runCheck({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeFs({files}).layer),
		),
	);

describe("surfaceMismatch — the anchor, not a second classifier", () => {
	it("refuses --surface prose over changed code files", () => {
		expect(surfaceMismatch("prose", ["a.ts", "b.ts"])).toContain("2 code files");
	});

	it("refuses --surface code over a diff with no code file", () => {
		expect(surfaceMismatch("code", ["README.md"])).toContain("no code file");
	});

	it("accepts a mixed diff under --surface code", () => {
		expect(surfaceMismatch("code", ["a.ts", "README.md"])).toBeNull();
	});
});

describe("classifyDiff — matched-neither is a bucket, not an absence", () => {
	it("names the files no surface validates", () => {
		expect(classifyDiff([".github/workflows/ci.yml", "scripts/x.sh", "a.ts", "R.md"])).toEqual({
			code: ["a.ts"],
			markdown: ["R.md"],
			unvalidated: [".github/workflows/ci.yml", "scripts/x.sh"],
		});
	});

	it("puts every file in exactly one bucket", () => {
		const files = ["a.tsx", "b.mjs", "c.json", "d.md", "e.mdx", "f.sql", "g.css", "LICENSE"];
		const {code, markdown, unvalidated} = classifyDiff(files);
		expect([...code, ...markdown, ...unvalidated].sort()).toEqual([...files].sort());
	});
});

describe("runCheck", () => {
	it("runs the exact CI commands with the cache bypassed, and reports what ran", async () => {
		const shell = fakeShell([
			...LANE_OK,
			[DIFF, okOut("apps/web/src/App.tsx\n")],
			[TYPECHECK, okOut("")],
			[LINT, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runCheck(options), Layer.merge(shell.layer, fakeFs({}).layer)),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			verdict: "green",
			surface: "code",
			tree: "/repo/trees/lane-a",
			ran: ["pnpm typecheck --force", "pnpm lint:worktree"],
			unvalidated: [],
		});
		expect(shell.calls).toContain("pnpm typecheck --force");
	});

	it("refuses red on 18, naming the runner that failed, with nothing on stdout", async () => {
		const out = await run([
			...LANE_OK,
			[DIFF, okOut("apps/web/src/App.tsx\n")],
			[TYPECHECK, errOut("src/App.tsx(12,3): error TS2345")],
		]);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"build check: red — pnpm typecheck --force failed; diagnostics above.",
		);
	});

	it("refuses an empty diff on 7 — zero scope is never a vacuous green (ADR 0092)", async () => {
		const out = await run([...LANE_OK, [DIFF, okOut("")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(
			"build check: the diff against origin/main is empty — nothing to validate (ADR 0092).",
		);
	});

	it("refuses a surface the diff provably contradicts on 10", async () => {
		const out = await run([...LANE_OK, [DIFF, okOut("apps/web/src/App.tsx\nsrc/x.ts\n")]], {
			surface: "prose",
		});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"build check: --surface prose, but the diff is 2 code files — the surface is provably wrong.",
		);
	});

	it("refuses an off-enum surface on 10, before touching the tree", async () => {
		const shell = fakeShell([]);
		const out = await Effect.runPromise(
			Effect.provide(
				runCheck({...options, surface: "design"}),
				Layer.merge(shell.layer, fakeFs({}).layer),
			),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(shell.calls).toEqual([]);
	});

	it("refuses a branch that is not this lane's on 14", async () => {
		const out = await run([
			[REV_PARSE, LINKED],
			[BRANCH, okOut("main\n")],
		]);
		expect(out.code).toBe(WRONG_LANE);
	});

	it("refuses an unreadable diff on 11 — UNKNOWN, never green", async () => {
		const out = await run([...LANE_OK, [DIFF, errOut("fatal: bad revision")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the verdict is UNKNOWN, never green");
	});

	it("reds a prose diff whose relative link does not resolve", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/guide.md\n")]],
			{surface: "prose"},
			{"/repo/trees/lane-a/docs/guide.md": "see [the other page](./missing.md)\n"},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("does not resolve"))).toBe(true);
	});

	it("reds a prose diff carrying a machine-local path", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/guide.md\n")]],
			{surface: "prose"},
			{"/repo/trees/lane-a/docs/guide.md": "run it from /Users/someone/phoenix\n"},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("machine-local path"))).toBe(true);
	});

	it("greens a prose diff whose links resolve", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/guide.md\n")]],
			{surface: "prose"},
			{
				"/repo/trees/lane-a/docs/guide.md": "see [the other page](./other.md)\n",
				"/repo/trees/lane-a/docs/other.md": "here\n",
			},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).verdict).toBe("green");
	});

	// The #5229 regression: before the third bucket existed, this exact diff returned
	// {"verdict":"green","surface":"prose","ran":["markdown link + leak scan"]} having opened no file.
	const WORKFLOW_ONLY = okOut(".github/workflows/ship.yml\nclaude-plugins/x/foo.sh\n");

	it("refuses a wholly-unvalidatable diff on 22 under --surface prose — the false green", async () => {
		const out = await run([...LANE_OK, [DIFF, WORKFLOW_ONLY]], {surface: "prose"});
		expect(out.code).toBe(UNCLASSIFIED_DIFF);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"build check: no surface validates any of the 2 changed file(s) (.github/workflows/ship.yml, claude-plugins/x/foo.sh) — there is nothing here to run, so the verdict is a refusal, never green.",
		);
	});

	it("refuses the same diff on 22 under --surface plan", async () => {
		const out = await run([...LANE_OK, [DIFF, WORKFLOW_ONLY]], {surface: "plan"});
		expect(out.code).toBe(UNCLASSIFIED_DIFF);
	});

	it("refuses the same diff on 22 under --surface code, naming the honest reason", async () => {
		const shell = fakeShell([...LANE_OK, [DIFF, WORKFLOW_ONLY]]);
		const out = await Effect.runPromise(
			Effect.provide(runCheck(options), Layer.merge(shell.layer, fakeFs({}).layer)),
		);
		expect(out.code).toBe(UNCLASSIFIED_DIFF);
		expect(out.stderr.at(-1)).toContain("no surface validates any of the 2 changed file(s)");
		expect(out.stderr.at(-1)).not.toContain("changes no code file");
		expect(shell.calls).not.toContain("pnpm typecheck --force");
	});

	it("discloses the unvalidated files on a partly-unvalidatable prose green (the #5187 shape)", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/guide.md\n.github/workflows/ship.yml\n")]],
			{surface: "prose"},
			{"/repo/trees/lane-a/docs/guide.md": "nothing to resolve here\n"},
		);
		expect(out.code).toBe(0);
		const verdict = JSON.parse(out.stdout);
		expect(verdict.verdict).toBe("green");
		expect(verdict.unvalidated).toEqual([".github/workflows/ship.yml"]);
		expect(out.stderr.some((line) => line.includes("NOT covered by this verdict"))).toBe(true);
	});

	it("discloses the unvalidated files on a partly-unvalidatable code green", async () => {
		const out = await run([
			...LANE_OK,
			[DIFF, okOut("apps/web/src/App.tsx\nscripts/deploy.sh\n")],
			[TYPECHECK, okOut("")],
			[LINT, okOut("")],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).unvalidated).toEqual(["scripts/deploy.sh"]);
	});

	it("reds a plan diff whose Dependencies block does not parse", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("plans/epic.md\n")]],
			{surface: "plan"},
			{"/repo/trees/lane-a/plans/epic.md": "## Dependencies\n\n- #12 comes after the API work\n"},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("does not parse"))).toBe(true);
	});

	it("reds a plan whose child requires itself", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("plans/epic.md\n")]],
			{surface: "plan"},
			{
				"/repo/trees/lane-a/plans/epic.md":
					"## Dependencies\n\n- phase 1: #12\n- #12 requires: #12\n",
			},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("requires itself"))).toBe(true);
	});

	it("greens a well-formed plan", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("plans/epic.md\n")]],
			{surface: "plan"},
			{
				"/repo/trees/lane-a/plans/epic.md":
					"## Dependencies\n\n- phase 1: #12\n- phase 2: #13\n- #13 requires: #12\n",
			},
		);
		expect(out.code).toBe(0);
	});
});
