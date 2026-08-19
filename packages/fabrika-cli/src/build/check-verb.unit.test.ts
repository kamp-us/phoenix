import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	classifyDiff,
	linkTargets,
	notCoveredBy,
	runCheck,
	SURFACES,
	surfaceMismatch,
} from "./check-verb.ts";
import {
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	UNCLASSIFIED_DIFF,
	VALIDATION_RED,
	WRONG_LANE,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	comments,
	GIT_DIRS,
	HEAD,
	issue,
	LANE_UUID,
	marker,
	NONCE,
} from "./fixtures.test-support.ts";

/** Every regex metacharacter escaped, so a scripted path matches itself and nothing else. */
const escapeRe = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The lane root `GIT_DIRS` reports — every base read is pinned to it. */
const ROOT = "/repo/trees/lane-a";

const REV_PARSE = /^git rev-parse --path-format=absolute/;
const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4312\/comments/;
const PERM = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;
const REPO_META = /^gh api repos\/o\/r --jq \.default_branch$/;
const MERGE_BASE = /^git merge-base HEAD origin\/main$/;
const DIFF = /^git diff --name-only /;
const UNTRACKED_ARGV = "git ls-files --others --exclude-standard --full-name -- :/";
const UNTRACKED = /^git ls-files --others --exclude-standard --full-name -- :\/$/;
/**
 * Anchored to the lane root, because that is what the pattern has to prove. An `ls-tree` pathspec
 * resolves against the process cwd, so a matcher that stops before `-C <root>` passes just as
 * happily on the cwd-relative shape that silently returns nothing (#5755 round 3).
 */
const LS_TREE = new RegExp(
	`^git -C ${escapeRe(ROOT)} --literal-pathspecs ls-tree -r --name-only -z `,
);
const TYPECHECK = /^pnpm typecheck --force$/;
const LINT = /^pnpm lint:worktree$/;

const LANE = `build/4312-editor-focus-loss-${NONCE}`;

/** A scripted untracked-file list. Placed ahead of `LANE_OK`, whose default is an empty one. */
const untracked = (stdout: string): readonly [RegExp, ExecResult] => [UNTRACKED, okOut(stdout)];

/**
 * The markdown the merge base already held, plus each file's bytes there.
 *
 * Placed ahead of `LANE_OK`, whose default is an empty base tree — i.e. every changed markdown file
 * is new, so its whole text is this diff's and the leak baseline subtracts nothing.
 */
const atBase = (
	files: Readonly<Record<string, string>>,
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[LS_TREE, okOut(`${Object.keys(files).join("\0")}\0`)],
	...Object.entries(files).map(
		([path, text]) =>
			[
				new RegExp(`^git -C ${escapeRe(ROOT)} show ${HEAD}:${escapeRe(path)}$`),
				okOut(text),
			] as const,
	),
];

const LANE_OK: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[REV_PARSE, GIT_DIRS],
	[BRANCH, okOut(`${LANE}\n`)],
	[ISSUE, issue()],
	[COMMENTS, comments({id: 1, body: marker("s-9f2e", LANE_UUID)})],
	[PERM, okOut("write\n")],
	[REPO_META, okOut("main\n")],
	[MERGE_BASE, okOut(`${HEAD}\n`)],
	untracked(""),
	[LS_TREE, okOut("")],
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
	unreadable: ReadonlyArray<string> = [],
) =>
	Effect.runPromise(
		Effect.provide(
			runCheck({...options, ...overrides}),
			Layer.merge(fakeShell(script).layer, fakeFs({files, unreadable}).layer),
		),
	);

describe("surfaceMismatch — the anchor, not a second classifier", () => {
	it("refuses --surface prose over a diff with no markdown file", () => {
		expect(surfaceMismatch("prose", ["a.ts", "b.ts"])).toContain("no markdown file");
	});

	it("refuses --surface code over a diff with no code file", () => {
		expect(surfaceMismatch("code", ["README.md"])).toContain("no code file");
	});

	it("refuses --surface plan over a diff with no markdown file", () => {
		expect(surfaceMismatch("plan", ["a.ts"])).toContain("no markdown file");
	});

	// #5301: the anchor refuses an ABSENT class, never a present other one — the asymmetry that left a
	// mixed diff's markdown with no surface to run under.
	it("refuses --surface workflows over a diff with no workflow file", () => {
		expect(surfaceMismatch("workflows", ["a.ts", "README.md"])).toContain("no workflows file");
	});

	it("accepts a diff holding every class under every surface", () => {
		for (const surface of SURFACES) {
			expect(
				surfaceMismatch(surface, ["a.ts", "README.md", ".github/workflows/ci.yml"]),
			).toBeNull();
		}
	});
});

describe("classifyDiff — matched-neither is a bucket, not an absence", () => {
	it("names the files no surface validates", () => {
		expect(classifyDiff([".github/workflows/ci.yml", "scripts/x.sh", "a.ts", "R.md"])).toEqual({
			code: ["a.ts"],
			markdown: ["R.md"],
			workflows: [".github/workflows/ci.yml"],
			unvalidatable: ["scripts/x.sh"],
		});
	});

	it("puts every file in exactly one bucket", () => {
		const files = [
			"a.tsx",
			"b.mjs",
			"c.json",
			"d.md",
			"e.mdx",
			"f.sql",
			"g.css",
			"LICENSE",
			".github/workflows/ci.yaml",
		];
		const {code, markdown, workflows, unvalidatable} = classifyDiff(files);
		expect([...code, ...markdown, ...workflows, ...unvalidatable].sort()).toEqual(
			[...files].sort(),
		);
	});

	it("claims workflow YAML only where GitHub reads it from", () => {
		const {workflows, unvalidatable} = classifyDiff([
			".github/workflows/ci.yml",
			".github/actions/setup/action.yml",
			"apps/web/config.yml",
		]);
		expect(workflows).toEqual([".github/workflows/ci.yml"]);
		expect(unvalidatable).toEqual([".github/actions/setup/action.yml", "apps/web/config.yml"]);
	});
});

describe("notCoveredBy — a green discloses what THIS surface did not read", () => {
	it("names the markdown a code run skipped", () => {
		expect(notCoveredBy("code", ["a.ts", "README.md"])).toEqual(["README.md"]);
	});

	it("names the code a plan run skipped — the symmetric case, same rule", () => {
		expect(notCoveredBy("plan", ["a.ts", "plans/epic.md"])).toEqual(["a.ts"]);
	});

	it("is empty only when the surface read every changed file", () => {
		expect(notCoveredBy("code", ["a.ts", "b.tsx"])).toEqual([]);
		expect(notCoveredBy("prose", ["docs/a.md"])).toEqual([]);
	});

	it("still carries the class no surface validates", () => {
		expect(notCoveredBy("code", ["a.ts", "scripts/deploy.sh"])).toEqual(["scripts/deploy.sh"]);
	});

	it("reports in diff order, so the list reads against the diff it came from", () => {
		expect(notCoveredBy("code", ["R.md", "a.ts", "x.sh"])).toEqual(["R.md", "x.sh"]);
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
			"build check: this tree changes nothing against origin/main, tracked or untracked — nothing to validate (ADR 0092).",
		);
	});

	it("refuses --surface prose on 10 over a diff with no markdown at all", async () => {
		const out = await run([...LANE_OK, [DIFF, okOut("apps/web/src/App.tsx\nsrc/x.ts\n")]], {
			surface: "prose",
		});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"build check: --surface prose, but the diff changes no markdown file — the surface is provably wrong.",
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
			[REV_PARSE, GIT_DIRS],
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

	// The #5229 regression: before the unvalidatable bucket existed, this diff shape returned
	// {"verdict":"green","surface":"prose","ran":["markdown link + leak scan"]} having opened no file.
	// It was a workflow-plus-shell diff then; the workflow half has validators of its own since #5991,
	// so the shape is now carried by two files that genuinely still have none.
	const NO_SURFACE = okOut("migrations/0007.sql\nclaude-plugins/x/foo.sh\n");

	it("refuses a wholly-unvalidatable diff on 22 under --surface prose — the false green", async () => {
		const out = await run([...LANE_OK, [DIFF, NO_SURFACE]], {surface: "prose"});
		expect(out.code).toBe(UNCLASSIFIED_DIFF);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"build check: no surface validates any of the 2 changed file(s) (claude-plugins/x/foo.sh, migrations/0007.sql) — there is nothing here to run, so the verdict is a refusal, never green.",
		);
	});

	it("refuses the same diff on 22 under --surface plan", async () => {
		const out = await run([...LANE_OK, [DIFF, NO_SURFACE]], {surface: "plan"});
		expect(out.code).toBe(UNCLASSIFIED_DIFF);
	});

	it("refuses the same diff on 22 under --surface workflows — no workflow file either", async () => {
		const out = await run([...LANE_OK, [DIFF, NO_SURFACE]], {surface: "workflows"});
		expect(out.code).toBe(UNCLASSIFIED_DIFF);
	});

	it("refuses the same diff on 22 under --surface code, naming the honest reason", async () => {
		const shell = fakeShell([...LANE_OK, [DIFF, NO_SURFACE]]);
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

	// The #5288 regression. README.md landed in the markdown bucket, so the green listed nothing — and
	// an empty `unvalidated` reads as "nothing uncovered" over a file no runner opened (`lint:worktree`
	// filters `.md` out by extension).
	it("names the markdown a --surface code green did not read", async () => {
		const out = await run(
			[
				...LANE_OK,
				[DIFF, okOut("apps/web/src/App.tsx\nREADME.md\n")],
				[TYPECHECK, okOut("")],
				[LINT, okOut("")],
			],
			{},
			{"/repo/trees/lane-a/README.md": "nothing to resolve here\n"},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).unvalidated).toEqual(["README.md"]);
		expect(out.stderr).toContain(
			"build check: 1 changed file(s) --surface code does not validate — NOT covered by this verdict: README.md.",
		);
	});

	it("names the code a --surface plan green did not read — same rule, mirrored", async () => {
		const shell = fakeShell([...LANE_OK, [DIFF, okOut("apps/web/src/App.tsx\nplans/epic.md\n")]]);
		const out = await Effect.runPromise(
			Effect.provide(
				runCheck({...options, surface: "plan"}),
				Layer.merge(
					shell.layer,
					fakeFs({
						files: {"/repo/trees/lane-a/plans/epic.md": "## Dependencies\n\n- phase 1: #12\n"},
					}).layer,
				),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).unvalidated).toEqual(["apps/web/src/App.tsx"]);
		expect(shell.calls).not.toContain("pnpm typecheck --force");
	});

	// Disclosing is not validating: --surface code names the markdown it skipped and stays green over
	// content the prose validators would red. Widening the surface to scan it is the fix #5288 declined.
	it("discloses the skipped markdown without scanning it", async () => {
		const out = await run(
			[
				...LANE_OK,
				[DIFF, okOut("apps/web/src/App.tsx\ndocs/guide.md\n")],
				[TYPECHECK, okOut("")],
				[LINT, okOut("")],
			],
			{},
			{"/repo/trees/lane-a/docs/guide.md": "run it from /Users/someone/phoenix\n"},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).unvalidated).toEqual(["docs/guide.md"]);
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

// The #5687 divergence: `build check` asked `report/leaks.ts`'s ISSUE-BODY scanner about a file in a
// diff, so it red on bytes `pipeline-cli leak-guard scan` — the gate it predicts — passes clean, and
// the red was unclearable inside the lane that inherited it.
describe("the prose leak scan predicts the committed-file gate, not the body guard", () => {
	const CONFIG = "/repo/trees/lane-a/.fabrika.jsonc";
	const LEAKY = "the Lineage bullets name ~/code/github.com/o/r on purpose\n";

	it("greens a fenced regex literal quoting the home marker", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("reports/snapshot.md\n")]],
			{surface: "prose"},
			{
				"/repo/trees/lane-a/reports/snapshot.md":
					"```bash\ngrep -nE '(~/|/Users/|/home/)' -- .\n```\n",
			},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).verdict).toBe("green");
	});

	it("greens a doc citing a scratch root — a temp root is a comment-surface rule", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("reports/snapshot.md\n")]],
			{surface: "prose"},
			{"/repo/trees/lane-a/reports/snapshot.md": "scratch lands under /tmp/fabrika-build/x\n"},
		);
		expect(out.code).toBe(0);
	});

	it("greens a doc the repo declared exempt", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("CLAUDE.md\n")]],
			{surface: "prose"},
			{[CONFIG]: '{"docLeakExempt": ["/CLAUDE.md"]}', "/repo/trees/lane-a/CLAUDE.md": LEAKY},
		);
		expect(out.code).toBe(0);
	});

	it("reds the same bytes in a doc the list does not name", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/guide.md\n")]],
			{surface: "prose"},
			{[CONFIG]: '{"docLeakExempt": ["/CLAUDE.md"]}', "/repo/trees/lane-a/docs/guide.md": LEAKY},
		);
		expect(out.code).toBe(VALIDATION_RED);
	});

	it("exempts nothing when the repo declares no list, and says so", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("CLAUDE.md\n")]],
			{surface: "prose"},
			{"/repo/trees/lane-a/CLAUDE.md": LEAKY},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("nothing is leak-scan exempt"))).toBe(true);
	});

	it("refuses an unreadable config on 11 — which docs are exempt is UNKNOWN, never green", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/guide.md\n")]],
			{surface: "prose"},
			{[CONFIG]: "{}", "/repo/trees/lane-a/docs/guide.md": "fine\n"},
			[CONFIG],
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});
});

// The #5301 regression, one leg per surface. `["a.ts", "README.md"]` is the repo's most common diff
// shape, and it had no invocation that opened the markdown: `code` never reads it, `plan` runs the
// grammar check, and `prose` refused on 10 because a code file was present. The leak scan and the
// link resolver never ran over a mixed diff under any surface.
describe("a mixed code+markdown diff — every surface has a runnable answer", () => {
	const MIXED = okOut("apps/web/src/App.tsx\nREADME.md\n");

	it("scans the markdown under --surface prose, reding on its machine-local path", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, MIXED]],
			{surface: "prose"},
			{
				"/repo/trees/lane-a/README.md": "run it from /Users/someone/phoenix\n",
			},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("machine-local path"))).toBe(true);
	});

	it("greens under --surface prose, disclosing the code file it did not read", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, MIXED]],
			{surface: "prose"},
			{
				"/repo/trees/lane-a/README.md": "see [the contract](./other.md)\n",
				"/repo/trees/lane-a/other.md": "here\n",
			},
		);
		expect(out.code).toBe(0);
		const verdict = JSON.parse(out.stdout);
		expect(verdict.ran).toEqual(["markdown link + leak scan"]);
		expect(verdict.unvalidated).toEqual(["apps/web/src/App.tsx"]);
	});

	it("runs the CI commands under --surface code, disclosing the markdown it did not read", async () => {
		const out = await run([...LANE_OK, [DIFF, MIXED], [TYPECHECK, okOut("")], [LINT, okOut("")]], {
			surface: "code",
		});
		expect(out.code).toBe(0);
		const verdict = JSON.parse(out.stdout);
		expect(verdict.ran).toEqual(["pnpm typecheck --force", "pnpm lint:worktree"]);
		expect(verdict.unvalidated).toEqual(["README.md"]);
	});

	it("runs the grammar check under --surface plan, disclosing the code file", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, MIXED]],
			{surface: "plan"},
			{
				"/repo/trees/lane-a/README.md": "## Dependencies\n\n- phase 1: #12\n",
			},
		);
		expect(out.code).toBe(0);
		const verdict = JSON.parse(out.stdout);
		expect(verdict.ran).toEqual(["markdown link + leak scan", "## Dependencies grammar"]);
		expect(verdict.unvalidated).toEqual(["apps/web/src/App.tsx"]);
	});
});

// #5304, hole 1. `catchTag("PlatformError")` caught every platform fault and `continue` skipped the
// file, so a permission or IO fault left `unvalidated` empty over a file nothing opened.
describe("a changed markdown file the verb cannot open", () => {
	const GUIDE = "/repo/trees/lane-a/docs/guide.md";

	it("refuses on 11 under --surface prose, naming the file and the reason", async () => {
		const out = await run([...LANE_OK, [DIFF, okOut("docs/guide.md\n")]], {surface: "prose"}, {}, [
			GUIDE,
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"build check: cannot read docs/guide.md (PermissionDenied) — it is in the diff and is not absent, so the verdict is UNKNOWN, never green.",
		);
	});

	it("refuses on 11 under --surface plan too — the same read, the same polarity", async () => {
		const out = await run([...LANE_OK, [DIFF, okOut("plans/epic.md\n")]], {surface: "plan"}, {}, [
			"/repo/trees/lane-a/plans/epic.md",
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("still greens over a file the diff lists and the tree no longer holds", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/gone.md\ndocs/here.md\n")]],
			{surface: "prose"},
			{"/repo/trees/lane-a/docs/here.md": "nothing to resolve here\n"},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).unvalidated).toEqual([]);
	});
});

// #5304, hole 2. `prose` and `plan` both claim the `markdown` class; the claim is only true while
// both run every validator that class gets, so `plan` runs the leak scan and the link resolver on
// top of the grammar rather than instead of it.
describe("--surface plan covers the markdown class it claims", () => {
	it("reds a plan ledger carrying a machine-local path", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("plans/epic.md\n")]],
			{surface: "plan"},
			{
				"/repo/trees/lane-a/plans/epic.md":
					"## Dependencies\n\n- phase 1: #12\n\nRun it from /Users/someone/phoenix\n",
			},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("machine-local path"))).toBe(true);
	});

	it("reds a plan ledger whose relative link does not resolve", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("plans/epic.md\n")]],
			{surface: "plan"},
			{
				"/repo/trees/lane-a/plans/epic.md":
					"## Dependencies\n\n- phase 1: #12\n\nsee [the brief](./missing.md)\n",
			},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("does not resolve"))).toBe(true);
	});

	it("earns its empty unvalidated list — the green names both validators that ran", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("plans/epic.md\n")]],
			{surface: "plan"},
			{"/repo/trees/lane-a/plans/epic.md": "## Dependencies\n\n- phase 1: #12\n"},
		);
		expect(out.code).toBe(0);
		const verdict = JSON.parse(out.stdout);
		expect(verdict.unvalidated).toEqual([]);
		expect(verdict.ran).toEqual(["markdown link + leak scan", "## Dependencies grammar"]);
	});
});

// #5823: `git diff` reports no untracked path, so a brand-new file reached neither the validated
// set nor `unvalidated` — invisible instead of disclosed, under a green verdict. The lane order is
// construct, check, then commit, so every new file is untracked exactly when the verb runs.
describe("the enumeration unions the untracked files with the diff", () => {
	it("counts an untracked file in the scanned scope", async () => {
		const out = await run([
			untracked("packages/fabrika-cli/src/build/pr-title.ts\n"),
			...LANE_OK,
			[DIFF, okOut("apps/web/src/App.tsx\n")],
			[TYPECHECK, okOut("")],
			[LINT, okOut("")],
		]);
		expect(out.code).toBe(0);
		expect(out.stderr).toContain("build check: 2 changed file(s) against origin/main.");
		expect(JSON.parse(out.stdout).unvalidated).toEqual([]);
	});

	it("names an untracked markdown file in a code run's unvalidated list", async () => {
		const out = await run([
			untracked("docs/new-guide.md\n"),
			...LANE_OK,
			[DIFF, okOut("apps/web/src/App.tsx\n")],
			[TYPECHECK, okOut("")],
			[LINT, okOut("")],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).unvalidated).toEqual(["docs/new-guide.md"]);
	});

	// The prose scanners read per enumerated file, so an unlisted markdown file is scanned by nothing.
	it("scans an untracked markdown file under --surface prose", async () => {
		const out = await run(
			[untracked("docs/new-guide.md\n"), ...LANE_OK, [DIFF, okOut("docs/tracked.md\n")]],
			{surface: "prose"},
			{
				"/repo/trees/lane-a/docs/tracked.md": "fine\n",
				"/repo/trees/lane-a/docs/new-guide.md": "run it from /Users/someone/phoenix\n",
			},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("machine-local path"))).toBe(true);
	});

	it("validates an all-untracked tree instead of refusing it as empty", async () => {
		const out = await run([
			untracked("apps/web/src/New.tsx\n"),
			...LANE_OK,
			[DIFF, okOut("")],
			[TYPECHECK, okOut("")],
			[LINT, okOut("")],
		]);
		expect(out.code).toBe(0);
		expect(out.stderr).toContain("build check: 1 changed file(s) against origin/main.");
	});

	it("lists a path both sources report exactly once", async () => {
		const out = await run([
			untracked("b.ts\na.ts\n"),
			...LANE_OK,
			[DIFF, okOut("b.ts\nc.ts\n")],
			[TYPECHECK, okOut("")],
			[LINT, okOut("")],
		]);
		expect(out.code).toBe(0);
		expect(out.stderr).toContain("build check: 3 changed file(s) against origin/main.");
	});

	it("still refuses on 7 when neither source yields a path", async () => {
		const out = await run([untracked(""), ...LANE_OK, [DIFF, okOut("")]]);
		expect(out.code).toBe(ZERO_SCOPE);
	});

	// Scripting stdout cannot catch a cwd-scoped read: bare `ls-files --others` answers only for the
	// cwd and answers cwd-relative, while `git diff` answers repo-wide and root-relative. Run from a
	// subdirectory that drops untracked files elsewhere in the tree and misresolves the rest against
	// `lane.root`. Only the argv proves the two reads cover the same tree, so assert the argv.
	it("reads the untracked list repo-wide and root-relative", async () => {
		const shell = fakeShell([
			untracked("apps/web/src/New.tsx\n"),
			...LANE_OK,
			[DIFF, okOut("apps/web/src/App.tsx\n")],
			[TYPECHECK, okOut("")],
			[LINT, okOut("")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(runCheck(options), Layer.merge(shell.layer, fakeFs({}).layer)),
		);
		expect(out.code).toBe(0);
		expect(shell.calls).toContain(UNTRACKED_ARGV);
	});

	it("refuses an unreadable untracked read on 11 — a short list is a fail-open green", async () => {
		const out = await run([
			[UNTRACKED, errOut("fatal: not a git repository")],
			...LANE_OK,
			[DIFF, okOut("apps/web/src/App.tsx\n")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the verdict is UNKNOWN, never green");
	});
});

// #5639: the extractor read a markdown link written as an *example* as a live one, so the five docs
// that state this repo's link convention could not pass the surface that reads them.
describe("linkTargets — an illustrated link is not a link", () => {
	const TOOLS_MD_493 =
		"`doc-links` validates markdown `[text](path)` links and *masks* code spans by construction.\n";

	it("returns no target for the TOOLS.md line that illustrates the link grammar", () => {
		expect(linkTargets(TOOLS_MD_493)).toEqual([]);
	});

	it("returns no target for a link inside a fenced block", () => {
		expect(linkTargets("intro\n\n```markdown\nSee [the ADR](NNNN-slug.md).\n```\n")).toEqual([]);
	});

	it("returns no target for a link inside a tilde fence, or a fence indented up to three", () => {
		expect(linkTargets("~~~\n[a](gone.md)\n~~~\n")).toEqual([]);
		expect(linkTargets("   ```\n[a](gone.md)\n   ```\n")).toEqual([]);
	});

	it("returns no target for a link inside a multi-backtick span", () => {
		expect(linkTargets("write `` [a](`x`.md) `` to show it\n")).toEqual([]);
	});

	it("still returns a real relative link", () => {
		expect(linkTargets("see [the index](.patterns/index.md) first\n")).toEqual([
			".patterns/index.md",
		]);
	});

	it("still returns a real repo-rooted link", () => {
		expect(linkTargets("see [the index](/.patterns/index.md)\n")).toEqual(["/.patterns/index.md"]);
	});

	it("still returns a link sharing its line with an unrelated code span", () => {
		expect(linkTargets("run `pnpm dev`, then read [the guide](DEVELOPMENT.md)\n")).toEqual([
			"DEVELOPMENT.md",
		]);
	});

	it("still returns a link after a fence closes, and after an unpartnered backtick", () => {
		expect(linkTargets("```\n[a](gone.md)\n```\n\n[b](DEVELOPMENT.md)\n")).toEqual([
			"DEVELOPMENT.md",
		]);
		expect(linkTargets("a lone ` tick, then [b](DEVELOPMENT.md)\n")).toEqual(["DEVELOPMENT.md"]);
	});

	it("keeps skipping schemes and bare fragments, masked or not", () => {
		expect(linkTargets("[home](https://kamp.us) and [top](#intro)\n")).toEqual([]);
	});
});

describe("the prose link check still reds a dead link", () => {
	const DOC = "/repo/trees/lane-a/docs/guide.md";

	it("reds a genuinely dead relative link in a changed doc", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/guide.md\n")]],
			{surface: "prose"},
			{
				[DOC]: "see [the plan](plan.md)\n",
			},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes('links to "plan.md"'))).toBe(true);
	});

	it("greens the same doc when that link is written as an example", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut("docs/guide.md\n")]],
			{surface: "prose"},
			{
				[DOC]: "write `[the plan](plan.md)` to cite it\n",
			},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).verdict).toBe("green");
	});
});

// #5755: the scan read the whole file, so a one-paragraph edit inherited every defect line already
// in it. The blocked case was a doc whose subject IS path hygiene, spelling the leak shapes out.
describe("the leak scan reds this diff's leaks, not the file's", () => {
	const FILE = "docs/guide.md";
	const PATH = `/repo/trees/lane-a/${FILE}`;
	const TAXONOMY = "an absolute home root reads /Users/account on macOS\n";

	it("greens a defect line the merge base already carried unchanged", async () => {
		const out = await run(
			[...atBase({[FILE]: TAXONOMY}), ...LANE_OK, [DIFF, okOut(`${FILE}\n`)]],
			{surface: "prose"},
			{[PATH]: `a new opening paragraph\n\n${TAXONOMY}`},
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).verdict).toBe("green");
	});

	it("reds a leak this diff introduced into a file that already carried another", async () => {
		const out = await run(
			[...atBase({[FILE]: TAXONOMY}), ...LANE_OK, [DIFF, okOut(`${FILE}\n`)]],
			{surface: "prose"},
			{[PATH]: `${TAXONOMY}the fork lives at ~/code/github.com/o/r\n`},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes("~/code/"))).toBe(true);
		expect(out.stderr.some((line) => line.includes("/Users/"))).toBe(false);
	});

	it("reds an added copy of a leak the base already held, counting occurrences", async () => {
		const out = await run(
			[...atBase({[FILE]: TAXONOMY}), ...LANE_OK, [DIFF, okOut(`${FILE}\n`)]],
			{surface: "prose"},
			{[PATH]: `${TAXONOMY}${TAXONOMY}`},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes(`${FILE}:2`))).toBe(true);
	});

	// Round 3 of #5755: an `ls-tree` pathspec resolves against the process cwd, and
	// `--literal-pathspecs` switches off the `:(top)` magic that would anchor it. From a
	// subdirectory the roster came back empty at exit 0 — indistinguishable from "this diff created
	// every one of them", which restored the exact false red this feature removes. Only the argv
	// proves the anchor; a matcher that stops before the operands passes under both shapes.
	it("pins both base reads to the lane root, operands and all", async () => {
		const shell = fakeShell([
			...atBase({[FILE]: TAXONOMY}),
			...LANE_OK,
			[DIFF, okOut(`${FILE}\n`)],
		]);
		await Effect.runPromise(
			Effect.provide(
				runCheck({...options, surface: "prose"}),
				Layer.merge(shell.layer, fakeFs({files: {[PATH]: TAXONOMY}}).layer),
			),
		);
		expect(shell.calls).toContain(
			`git -C ${ROOT} --literal-pathspecs ls-tree -r --name-only -z ${HEAD} -- ${FILE}`,
		);
		expect(shell.calls).toContain(`git -C ${ROOT} show ${HEAD}:${FILE}`);
	});

	it("reds the whole text of a doc this diff creates — nothing predates a new file", async () => {
		const out = await run(
			[...LANE_OK, [DIFF, okOut(`${FILE}\n`)]],
			{surface: "prose"},
			{[PATH]: TAXONOMY},
		);
		expect(out.code).toBe(VALIDATION_RED);
	});

	it("refuses on 11 when the base tree cannot be listed — what predates the diff is UNKNOWN", async () => {
		const out = await run(
			[[LS_TREE, errOut("fatal: not a tree object")], ...LANE_OK, [DIFF, okOut(`${FILE}\n`)]],
			{surface: "prose"},
			{[PATH]: TAXONOMY},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.some((line) => line.includes(`merge base ${HEAD}`))).toBe(true);
		// This refusal is raised past the exemption read, so it owes the same scope line every other
		// refusal past that point carries.
		expect(out.stderr.some((line) => line.includes("nothing is leak-scan exempt"))).toBe(true);
	});

	it("refuses on 11 when a file in the base tree cannot be read there", async () => {
		const out = await run(
			[
				[LS_TREE, okOut(`${FILE}\0`)],
				[new RegExp(`^git -C ${escapeRe(ROOT)} show `), errOut("fatal: bad object")],
				...LANE_OK,
				[DIFF, okOut(`${FILE}\n`)],
			],
			{surface: "prose"},
			{[PATH]: TAXONOMY},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.some((line) => line.includes(`merge base ${HEAD}`))).toBe(true);
	});

	// The link resolver is deliberately NOT baselined: a link's resolvability is a property of the
	// tree, so an untouched line goes dead the moment the diff moves its target.
	it("still reds a dead link on a line the merge base carried unchanged", async () => {
		const DEAD = "see [the plan](plan.md)\n";
		const out = await run(
			[...atBase({[FILE]: DEAD}), ...LANE_OK, [DIFF, okOut(`${FILE}\n`)]],
			{surface: "prose"},
			{[PATH]: DEAD},
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.some((line) => line.includes('links to "plan.md"'))).toBe(true);
	});
});

// #5991: a workflows-only diff refused under every surface, so the repo's own gates were the one
// diff class a lane could not get an in-tree green on.
describe("--surface workflows", () => {
	const CONFIG = "/repo/trees/lane-a/.fabrika.jsonc";
	const GUARD = ["node", "guards/bin.js", "path-filter-guard", "check"];
	const declaring = (reads: ReadonlyArray<string>) => ({
		[CONFIG]: JSON.stringify({workflowValidators: [{command: GUARD, reads}]}),
	});
	const DECLARED = declaring([".github/workflows/ci.yml"]);
	const GUARD_LINE = /^node guards\/bin\.js path-filter-guard check$/;
	const ACTIONLINT = /^actionlint /;
	const WORKFLOWS = okOut(".github/workflows/ci.yml\n.github/workflows/publish.yml\n");
	const NO_ACTIONLINT = [ACTIONLINT];

	const workflows = (
		script: ReadonlyArray<readonly [RegExp, ExecResult]>,
		files: Record<string, string> = DECLARED,
		unstartable: ReadonlyArray<RegExp> = [],
	) => {
		const shell = fakeShell([...LANE_OK, [DIFF, WORKFLOWS], ...script], undefined, unstartable);
		return Effect.runPromise(
			Effect.provide(
				runCheck({...options, surface: "workflows"}),
				Layer.merge(shell.layer, fakeFs({files}).layer),
			),
		).then((out) => ({out, calls: shell.calls}));
	};

	it("greens a workflows-only diff, naming actionlint and the declared guard as what ran", async () => {
		const {out, calls} = await workflows([
			[ACTIONLINT, okOut("")],
			[GUARD_LINE, okOut("")],
		]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			verdict: "green",
			surface: "workflows",
			tree: "/repo/trees/lane-a",
			ran: ["actionlint", GUARD.join(" ")],
			unvalidated: [],
		});
		expect(calls).toContain("actionlint .github/workflows/ci.yml .github/workflows/publish.yml");
	});

	it("reds on 18 when actionlint reds, printing its diagnostics above the verdict", async () => {
		const {out} = await workflows([[ACTIONLINT, errOut('ci.yml:7:9: unexpected key "runs-on"')]]);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-2)).toBe('ci.yml:7:9: unexpected key "runs-on"');
		expect(out.stderr.at(-1)).toBe("build check: red — actionlint failed; diagnostics above.");
	});

	it("bounds a runaway linter's output, so the verdict is not buried under it", async () => {
		const flood = Array.from({length: 60}, (_, i) => `ci.yml:${i}:1: nope`).join("\n");
		const {out} = await workflows([[ACTIONLINT, errOut(flood)]]);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.at(-2)).toBe("… 20 more line(s); re-run the command itself for the rest.");
		expect(out.stderr.at(-1)).toBe("build check: red — actionlint failed; diagnostics above.");
	});

	it("reds on 18 when a declared guard reds, naming the command", async () => {
		const {out} = await workflows([
			[ACTIONLINT, okOut("")],
			[GUARD_LINE, errOut("ci.yml's path filter names a path no job reads")],
		]);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.at(-1)).toBe(
			`build check: red — ${GUARD.join(" ")} failed; diagnostics above.`,
		);
	});

	it("greens without actionlint, disclosing that it did not run", async () => {
		const {out} = await workflows(
			[[GUARD_LINE, okOut("")]],
			declaring([".github/workflows/ci.yml", ".github/workflows/publish.yml"]),
			NO_ACTIONLINT,
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).ran).toEqual([GUARD.join(" ")]);
		expect(JSON.parse(out.stdout).unvalidated).toEqual([]);
		expect(out.stderr.some((line) => line.includes("actionlint did NOT run"))).toBe(true);
	});

	// The finding on #6220's first round: `ran.length > 0` proves a validator ran, never that it
	// opened the file the diff changed. Only actionlint takes the changed paths; a declared guard
	// reads the fixed set it names, so coverage is per file or it is a claim about nothing.
	it("names a changed workflow no validator that ran opens in `unvalidated`", async () => {
		const {out} = await workflows([[GUARD_LINE, okOut("")]], DECLARED, NO_ACTIONLINT);
		expect(out.code).toBe(0);
		const verdict = JSON.parse(out.stdout);
		expect(verdict.ran).toEqual([GUARD.join(" ")]);
		expect(verdict.unvalidated).toEqual([".github/workflows/publish.yml"]);
		expect(
			out.stderr.some((line) =>
				line.includes("no validator that ran opens .github/workflows/publish.yml"),
			),
		).toBe(true);
	});

	it("refuses on 11 when every validator ran and none of them opened a changed file", async () => {
		const {out} = await workflows(
			[[GUARD_LINE, okOut("")]],
			declaring([".github/workflows/deploy.yml"]),
			NO_ACTIONLINT,
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain(
			"none of them opened any of the 2 changed workflow file(s)",
		);
	});

	it("refuses the whole declared list when an entry names no file it reads", async () => {
		const {out} = await workflows([], {[CONFIG]: JSON.stringify({workflowValidators: [GUARD]})}, [
			ACTIONLINT,
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("no workflow validator could be executed");
	});

	it("refuses on 11 when nothing could run — a green there would have opened no file", async () => {
		const {out} = await workflows([], {}, NO_ACTIONLINT);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("no workflow validator could be executed");
		expect(out.stderr.at(-1)).toContain("actionlint is not installed here");
	});

	it("refuses on 11 when a declared guard is not installed, naming it", async () => {
		const {out} = await workflows([[ACTIONLINT, okOut("")]], DECLARED, [GUARD_LINE]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain(`${GUARD.join(" ")} could not be executed`);
	});

	it("refuses on 11 when the config cannot be read — the validator set is UNKNOWN", async () => {
		const shell = fakeShell([...LANE_OK, [DIFF, WORKFLOWS], [ACTIONLINT, okOut("")]]);
		const out = await Effect.runPromise(
			Effect.provide(
				runCheck({...options, surface: "workflows"}),
				Layer.merge(shell.layer, fakeFs({files: {[CONFIG]: "{}"}, unreadable: [CONFIG]}).layer),
			),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("which commands validate this repo's workflows is UNKNOWN");
	});

	it("refuses on 10 over a diff with no workflow file", async () => {
		const shell = fakeShell([...LANE_OK, [DIFF, okOut("apps/web/src/App.tsx\n")]]);
		const out = await Effect.runPromise(
			Effect.provide(
				runCheck({...options, surface: "workflows"}),
				Layer.merge(shell.layer, fakeFs({}).layer),
			),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"build check: --surface workflows, but the diff changes no workflows file — the surface is provably wrong.",
		);
	});
});

describe("a mixed workflow-plus-code diff — each surface reads its own class and names the other", () => {
	const MIXED = okOut(".github/workflows/ci.yml\napps/web/src/App.tsx\n");
	const CONFIG = "/repo/trees/lane-a/.fabrika.jsonc";

	it("runs the CI commands under --surface code, disclosing the workflow it did not read", async () => {
		const out = await run([...LANE_OK, [DIFF, MIXED], [TYPECHECK, okOut("")], [LINT, okOut("")]]);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).unvalidated).toEqual([".github/workflows/ci.yml"]);
	});

	it("lints the workflow under --surface workflows, disclosing the code it did not read", async () => {
		const shell = fakeShell([...LANE_OK, [DIFF, MIXED], [/^actionlint /, okOut("")]]);
		const out = await Effect.runPromise(
			Effect.provide(
				runCheck({...options, surface: "workflows"}),
				Layer.merge(shell.layer, fakeFs({files: {[CONFIG]: "{}"}}).layer),
			),
		);
		expect(out.code).toBe(0);
		const verdict = JSON.parse(out.stdout);
		expect(verdict.ran).toEqual(["actionlint"]);
		expect(verdict.unvalidated).toEqual(["apps/web/src/App.tsx"]);
		expect(shell.calls).toContain("actionlint .github/workflows/ci.yml");
		expect(out.stderr.some((line) => line.includes("NOT covered by this verdict"))).toBe(true);
	});
});

// #6297: the code surface's commands are the repo's declaration, and "no validator is present" is a
// third answer — not the `VALIDATION_RED` that says the code failed, and not a green either.
describe("--surface code reads its validators from the config", () => {
	const CONFIG = "/repo/trees/lane-a/.fabrika.jsonc";
	const CODE = okOut("apps/web/src/App.tsx\n");

	const codeRun = (
		script: ReadonlyArray<readonly [RegExp, ExecResult]>,
		config: string | null,
		unstartable: ReadonlyArray<RegExp> = [],
	) => {
		const shell = fakeShell([...LANE_OK, [DIFF, CODE], ...script], undefined, unstartable);
		return Effect.runPromise(
			Effect.provide(
				runCheck(options),
				Layer.merge(shell.layer, fakeFs({files: {[CONFIG]: config}}).layer),
			),
		).then((out) => ({out, calls: shell.calls}));
	};

	it("runs what the repo declared, and none of the shipped pair", async () => {
		const {out, calls} = await codeRun(
			[[/^make check$/, okOut("")]],
			'{"codeValidators": [{"command": ["make", "check"]}]}',
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).ran).toEqual(["make check"]);
		expect(calls).toContain("make check");
		expect(calls).not.toContain("pnpm typecheck --force");
	});

	it("falls back to the shipped pair when the file declares no `codeValidators`", async () => {
		const {out, calls} = await codeRun(
			[
				[TYPECHECK, okOut("")],
				[LINT, okOut("")],
			],
			"{}",
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).ran).toEqual(["pnpm typecheck --force", "pnpm lint:worktree"]);
		expect(calls).toContain("pnpm lint:worktree");
	});

	it("refuses UNKNOWN on an explicitly empty list — never green, never red", async () => {
		const {out} = await codeRun([], '{"codeValidators": []}');
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"build check: .fabrika.jsonc declares an empty `codeValidators` — no code validator is present here, so nothing ran and the verdict is UNKNOWN, never green and never red.",
		);
	});

	it("refuses UNKNOWN naming a declared validator that cannot be spawned", async () => {
		const {out} = await codeRun([], '{"codeValidators": [{"command": ["biome", "ci"]}]}', [
			/^biome ci$/,
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("build check: biome ci could not be executed:");
		expect(out.stderr.at(-1)).toContain("UNKNOWN, never green");
	});

	it("still reds on a declared validator that ran and failed", async () => {
		const {out} = await codeRun(
			[[/^make check$/, errOut("Makefile:3: recipe for target 'check' failed")]],
			'{"codeValidators": [{"command": ["make", "check"]}]}',
		);
		expect(out.code).toBe(VALIDATION_RED);
		expect(out.stderr.at(-1)).toBe("build check: red — make check failed; diagnostics above.");
		expect(out.stderr).toContain("Makefile:3: recipe for target 'check' failed");
	});

	it("refuses UNKNOWN on a malformed declaration rather than guessing a command", async () => {
		const {out} = await codeRun([], '{"codeValidators": [{"command": []}]}');
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("`codeValidators` holds an entry that is not");
	});

	it("refuses UNKNOWN on a config file it cannot open", async () => {
		const shell = fakeShell([...LANE_OK, [DIFF, CODE]]);
		const out = await Effect.runPromise(
			Effect.provide(
				runCheck(options),
				Layer.merge(shell.layer, fakeFs({files: {[CONFIG]: "{}"}, unreadable: [CONFIG]}).layer),
			),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("is UNKNOWN, never green");
		expect(shell.calls).not.toContain("pnpm typecheck --force");
	});
});
