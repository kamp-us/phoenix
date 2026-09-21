/**
 * `review preview`'s three subjects over the same scripted seams the group's read verbs test at:
 * the PR arm binds a head and reads the object database exactly as `review diff` does, the range
 * arm reads over its own merge base, and the `--diff-file` arm stays the local read it was. The
 * refusal matrix at the bottom pins the subject vocabulary: two subjects refuse, a PR-subject
 * modifier beside a headless subject refuses, and a range validates through `readRangeFlags`.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	fakeFs,
	fakeSeams,
	type HttpReply,
	okOut,
	type Scripted,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	GOVERNED_FILTER,
	INCOMPLETE_SCAN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	STALE_HEAD,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	BASE,
	binding,
	DIFF,
	DIFF_AT,
	HEAD,
	OLD_HEAD,
	PATHS_AT,
	paths,
	pull,
} from "./fixtures.test-support.ts";
import {runPreview} from "./preview-verb.ts";

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321$/;
const PR = 4321;

/** A canned payload as the platform serves it — the fixtures speak `ExecResult`, the seam HTTP. */
const served = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

const options = {
	diffFile: null as string | null,
	pr: null as number | null,
	sha: null as string | null,
	repo: null as string | null,
	base: null as string | null,
	tip: null as string | null,
	filterPlacement: "after" as string | null,
	exclude: null as string | null,
	emitDiff: false,
	json: false,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const shell = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const fake = fakeSeams(script);
	return {
		fake,
		out: Effect.runPromise(
			Effect.provide(
				runPreview({...options, ...overrides}),
				Layer.merge(fake.layer, fakeFs({files: diffFiles}).layer),
			),
		),
	};
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	shell(script, overrides).out;

/** The layer a governed-roots case runs over: the declared roots replace the shipped defaults. */
const overRoots = (roots: ReadonlyArray<string>) =>
	fakeFs({files: {...diffFiles, "/repo/.fabrika.jsonc": JSON.stringify({governedRoots: roots})}})
		.layer;

const runOverRoots = (
	script: ReadonlyArray<Scripted>,
	roots: ReadonlyArray<string>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runPreview({...options, ...overrides}),
			Layer.merge(fakeSeams(script).layer, overRoots(roots)),
		),
	);

const diffFiles: Record<string, string> = {};
const diffOnDisk = (text: string = DIFF): string => {
	const path = `/repo/sample-${Object.keys(diffFiles).length}.diff`;
	diffFiles[path] = text;
	return path;
};

/**
 * The whole PR green path: the PR read, the binding reads, the diff at the bound commit, and the
 * `--name-only` read of the SAME range the completeness proof is taken against. Reuses the shared
 * `binding()` script — the RAW row it carries is simply never matched, since a preview digests
 * nothing.
 */
const prGreen = (
	diff: string = DIFF,
	inRange: ReadonlyArray<string> = ["src/cart.ts", "README.md"],
): ReadonlyArray<Scripted> => [
	[PULL, served(pull())],
	...binding(),
	[DIFF_AT(), okOut(diff)],
	[PATHS_AT(), paths(...inRange)],
];

/** The range arm's subject ends, and the commit its three-dot diff is taken from. */
const RANGE_BASE = BASE;
const RANGE_TIP = HEAD;
const MB = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const RANGE_SUBJECT = {base: RANGE_BASE, tip: RANGE_TIP};

const mergeBaseAt = (): readonly [RegExp, ExecResult] => [
	new RegExp(`^git merge-base ${RANGE_BASE} ${RANGE_TIP}$`),
	okOut(`${MB}\n`),
];

const rangeGreen = (
	diff: string = DIFF,
	inRange: ReadonlyArray<string> = ["src/cart.ts", "README.md"],
): ReadonlyArray<Scripted> => [
	mergeBaseAt(),
	[DIFF_AT(MB, RANGE_TIP), okOut(diff)],
	[PATHS_AT(MB, RANGE_TIP), paths(...inRange)],
];

/** The text rows `previewOf` derives over `DIFF` under the default exclusions — no path excluded. */
const TWO_FILE_ROWS = [
	"preview\tafter",
	"matched\t2",
	"class\tcode\t1",
	"class\tdoc\t1",
	"namespace\treview-code",
	"namespace\treview-doc",
	"excluded\t0",
].join("\n");

describe("runPreview takes exactly one subject", () => {
	it("refuses --diff-file beside a pull-request number, naming the conflict before any read", async () => {
		const out = await run([], {diffFile: "/nonexistent.diff", pr: PR});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("--diff-file and a pull-request number name two subjects");
	});

	it("refuses --diff-file beside a range", async () => {
		const out = await run([], {
			diffFile: "/nonexistent.diff",
			...RANGE_SUBJECT,
		});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("--diff-file and --base/--tip name two subjects");
	});

	it("refuses a pull-request number beside a range", async () => {
		const out = await run([], {pr: PR, ...RANGE_SUBJECT});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("a pull-request number and --base/--tip name two subjects");
	});

	it("refuses no subject at all, naming the three forms", async () => {
		const out = await run([]);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"review preview: name exactly one subject — --diff-file <path>, a pull-request number, or --base/--tip.",
		);
	});

	it("refuses --sha beside --diff-file rather than silently ignoring it", async () => {
		const out = await run([], {diffFile: "/nonexistent.diff", sha: HEAD});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("--sha and --repo are PR-subject modifiers");
	});

	it("refuses --repo beside a range — a range binds content in this checkout", async () => {
		const out = await run([], {...RANGE_SUBJECT, repo: "o/r"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"review preview: --repo is a PR-subject modifier — a range binds content in this checkout, not a named repository.",
		);
	});

	it("refuses a lone --base through readRangeFlags", async () => {
		const out = await run([], {base: RANGE_BASE});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"review preview: --base and --tip come together — a range has two ends.",
		);
	});

	it("refuses --sha beside a range through readRangeFlags — a range binds content, not a head", async () => {
		const out = await run([], {...RANGE_SUBJECT, sha: HEAD});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("binds content, not a head");
	});

	it("refuses a range end that is not a revision through readRangeFlags", async () => {
		const out = await run([], {base: "HEAD~1", tip: RANGE_TIP});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("is not a revision — expected 7–40 lowercase hex");
	});
});

describe("runPreview reads a pull request exactly as review diff does", () => {
	it("prints the preview rows and binds the commit on stderr", async () => {
		const out = await run(prGreen(), {pr: PR});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`${TWO_FILE_ROWS}\n`);
		expect(out.stderr[0]).toBe(
			`review preview: bound to ${HEAD} (base ${BASE}) — read from the object database, nothing checked out.`,
		);
	});

	it("refuses a diff short of the range's own file list on 13 — a short read never reaches the filter", async () => {
		const out = await run(prGreen(DIFF, ["src/cart.ts", "README.md", "src/dropped.ts"]), {
			pr: PR,
		});
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr[0]).toBe(
			`review preview: bound to ${HEAD} (base ${BASE}) — read from the object database, nothing checked out.`,
		);
		expect(out.stderr.at(-1)).toBe(
			`review preview: the diff at ${HEAD} carries 2 of the 3 files git reports for the same range ${BASE}...${HEAD} — both counts from git, so this diff is provably short; refusing to serve a partial diff as the whole.`,
		);
	});

	it("refuses on 11 when the range's file list cannot be read, rather than proving completeness against nothing", async () => {
		const out = await run(
			[
				[PULL, served(pull())],
				...binding(),
				[DIFF_AT(), okOut(DIFF)],
				[PATHS_AT(), errOut("fatal: bad revision")],
			],
			{pr: PR},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read the file list of the range");
	});

	it("refuses on 11 when the diff itself cannot be read out of the object database", async () => {
		const out = await run(
			[[PULL, served(pull())], ...binding(), [DIFF_AT(), errOut("fatal: bad object")]],
			{pr: PR},
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot read the diff for #4321 at");
	});

	it("refuses on 12 when --sha is not the PR's head, instead of reading whatever is live", async () => {
		const {fake, out} = shell(prGreen(), {pr: PR, sha: OLD_HEAD});
		const result = await out;
		expect(result.code).toBe(STALE_HEAD);
		expect(result.stdout).toBe("");
		expect(result.stderr.at(-1)).toContain("re-scope at");
		expect(fake.calls.some((call) => call.startsWith("git diff"))).toBe(false);
	});

	it("refuses a zero-file PR on 7 rather than previewing nothing", async () => {
		const out = await run([[PULL, served(pull({changedFiles: 0}))]], {pr: PR});
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("refusing to preview an empty diff.");
	});

	it("carries the same --json fields as the --diff-file subject — --json gains no provenance", async () => {
		const pr = await run(prGreen(), {pr: PR, json: true});
		const disk = await run([], {diffFile: diffOnDisk(), json: true});
		expect(pr.code).toBe(0);
		expect(disk.code).toBe(0);
		expect(Object.keys(JSON.parse(pr.stdout)).sort()).toEqual(
			Object.keys(JSON.parse(disk.stdout)).sort(),
		);
	});

	// The filter pipeline is the same code behind every subject: same defaults, same --exclude,
	// same placement — so one subject's rows are another's over the same bytes.
	it("runs the identical filter pipeline the --diff-file subject runs", async () => {
		const pr = await run(prGreen(), {pr: PR, exclude: "README.md"});
		const disk = await run([], {diffFile: diffOnDisk(), exclude: "README.md"});
		expect(pr.code).toBe(0);
		expect(disk.code).toBe(0);
		expect(pr.stdout).toBe(disk.stdout);
		expect(pr.stdout).toContain("excluded-path\tREADME.md");
		expect(pr.stdout).toContain("matched\t1");
	});

	it("refuses an exclusion pattern matching a declared governed root on 21", async () => {
		const out = await runOverRoots(prGreen(), ["src/", ".fabrika.jsonc"], {
			pr: PR,
			exclude: "src/**",
		});
		expect(out.code).toBe(GOVERNED_FILTER);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("intersects a governed root");
		expect(out.stderr.join("\n")).toContain("src/probe.md");
	});
});

describe("runPreview reads a range over its own merge base", () => {
	it("prints the preview rows read from the merge-base...tip diff, and no GitHub read at all", async () => {
		const {fake, out} = shell(rangeGreen(), RANGE_SUBJECT);
		const result = await out;
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`${TWO_FILE_ROWS}\n`);
		expect(result.stderr[0]).toBe(
			`review preview: range ${RANGE_BASE}...${RANGE_TIP} at merge base ${MB} — read from the object database, nothing checked out.`,
		);
		expect(fake.requests).toEqual([]);
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ ${MB}...${RANGE_TIP}`,
		);
		// Both operands of the completeness proof come from the SAME three-dot range.
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ --name-only -z ${MB}...${RANGE_TIP}`,
		);
	});

	it("refuses on 11 when the range's merge base cannot be resolved — the diff is UNKNOWN", async () => {
		const out = await run(
			[[/^git merge-base /, errOut("fatal: Not a valid object name")]],
			RANGE_SUBJECT,
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain(
			`cannot resolve the merge base of ${RANGE_BASE} and ${RANGE_TIP}`,
		);
	});

	it("refuses a range diff short of the range's own file list on 13", async () => {
		const out = await run(rangeGreen(DIFF, ["src/cart.ts", "README.md", "src/dropped.ts"]), {
			...RANGE_SUBJECT,
		});
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr[0]).toBe(
			`review preview: range ${RANGE_BASE}...${RANGE_TIP} at merge base ${MB} — read from the object database, nothing checked out.`,
		);
		expect(out.stderr.at(-1)).toBe(
			`review preview: the diff at ${RANGE_TIP} carries 2 of the 3 files git reports for the same range ${RANGE_BASE}...${RANGE_TIP} — both counts from git, so this diff is provably short; refusing to serve a partial diff as the whole.`,
		);
	});

	it("refuses on 11 when the range's file list cannot be read", async () => {
		const out = await run(
			[
				mergeBaseAt(),
				[DIFF_AT(MB, RANGE_TIP), okOut(DIFF)],
				[PATHS_AT(MB, RANGE_TIP), errOut("fatal: bad revision")],
			],
			RANGE_SUBJECT,
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot read the file list of the range");
	});

	it("refuses an exclusion pattern matching a declared governed root on 21, with the range named", async () => {
		const out = await runOverRoots(rangeGreen(), ["src/", ".fabrika.jsonc"], {
			...RANGE_SUBJECT,
			exclude: "src/**",
		});
		expect(out.code).toBe(GOVERNED_FILTER);
		expect(out.stdout).toBe("");
		expect(out.stderr[0]).toBe(
			`review preview: range ${RANGE_BASE}...${RANGE_TIP} at merge base ${MB} — read from the object database, nothing checked out.`,
		);
		expect(out.stderr.join("\n")).toContain("intersects a governed root");
	});

	it("carries the same --json fields as the --diff-file subject", async () => {
		const range = await run(rangeGreen(), {...RANGE_SUBJECT, json: true});
		const disk = await run([], {diffFile: diffOnDisk(), json: true});
		expect(range.code).toBe(0);
		expect(Object.keys(JSON.parse(range.stdout)).sort()).toEqual(
			Object.keys(JSON.parse(disk.stdout)).sort(),
		);
	});

	it("runs the identical filter pipeline the --diff-file subject runs", async () => {
		const range = await run(rangeGreen(), {
			...RANGE_SUBJECT,
			filterPlacement: "after",
			exclude: "src/cart.ts",
		});
		const disk = await run([], {
			diffFile: diffOnDisk(),
			filterPlacement: "after",
			exclude: "src/cart.ts",
		});
		expect(range.code).toBe(0);
		expect(range.stdout).toBe(disk.stdout);
		// `after` derives the partition over the FULL read — the class rows stand beside the
		// exclusion, which is the placement's whole point.
		expect(range.stdout).toContain("class\tcode\t1");
		expect(range.stdout).toContain("class\tdoc\t1");
		expect(range.stdout).toContain("excluded-path\tsrc/cart.ts");
	});
});

/**
 * The exclusion set's config arms.
 *
 * `reviewFilterExclusions` extends the effective set, `reviewFilterUnexclude` removes a shipped
 * default. Every subject threads the same effective set — a removal is enumerated (`un-excluded`
 * rows, the `unexcluded` JSON field, the `x-fabrika-unexcluded-path` header) so a narrowed filter
 * is never silent, and with both keys empty the emission is byte-identical to a run that never
 * read them.
 */
describe("runPreview's exclusion set reads .fabrika.jsonc", () => {
	const LOCK_DIFF = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -10,2 +10,3 @@
 const items = read();
+const extra = 1;
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,1 +1,2 @@
+  effect:
`;
	const PR_LOCK = prGreen(LOCK_DIFF, ["src/cart.ts", "pnpm-lock.yaml"]);
	const configured = (config: Record<string, unknown>) =>
		fakeFs({files: {...diffFiles, "/repo/.fabrika.jsonc": JSON.stringify(config)}}).layer;

	const runOverConfig = (
		script: ReadonlyArray<Scripted>,
		config: Record<string, unknown>,
		overrides: Partial<typeof options> = {},
	) =>
		Effect.runPromise(
			Effect.provide(
				runPreview({...options, ...overrides}),
				Layer.merge(fakeSeams(script).layer, configured(config)),
			),
		);

	it("leaves stdout and stderr byte-identical when the keys are absent, the file empty, or both lists empty", async () => {
		const plain = await run(prGreen(), {pr: PR});
		const braces = await runOverConfig(prGreen(), {}, {pr: PR});
		const empty = await runOverConfig(
			prGreen(),
			{reviewFilterExclusions: [], reviewFilterUnexclude: []},
			{pr: PR},
		);
		expect(braces.stdout).toBe(plain.stdout);
		expect(braces.stderr).toEqual(plain.stderr);
		expect(empty.stdout).toBe(plain.stdout);
		expect(empty.stderr).toEqual(plain.stderr);
		expect(empty.stdout).toContain("excluded\t0");
		expect(empty.stdout).not.toContain("un-excluded");
	});

	it("extends the exclusion set with the declared globs on every subject", async () => {
		const pr = await runOverConfig(prGreen(), {reviewFilterExclusions: ["README.md"]}, {pr: PR});
		const disk = await runOverConfig(
			[],
			{reviewFilterExclusions: ["README.md"]},
			{
				diffFile: diffOnDisk(),
			},
		);
		expect(pr.code).toBe(0);
		expect(pr.stdout).toBe(disk.stdout);
		expect(pr.stdout).toContain("excluded\t1");
		expect(pr.stdout).toContain("excluded-path\tREADME.md");
		expect(pr.stdout).toContain("matched\t1");
	});

	it("enumerates a removed default in the rows and the JSON — and serves its section", async () => {
		const text = await runOverConfig(
			PR_LOCK,
			{reviewFilterUnexclude: ["pnpm-lock.yaml"]},
			{pr: PR},
		);
		expect(text.code).toBe(0);
		const lines = text.stdout.split("\n");
		expect(lines).toContain("excluded\t0");
		expect(lines).toContain("un-excluded\t1");
		expect(lines).toContain("un-excluded-path\tpnpm-lock.yaml");
		expect(lines.indexOf("un-excluded-path\tpnpm-lock.yaml")).toBeGreaterThan(
			lines.indexOf("excluded\t0"),
		);
		const json = await runOverConfig(
			PR_LOCK,
			{reviewFilterUnexclude: ["pnpm-lock.yaml"]},
			{pr: PR, json: true},
		);
		expect(JSON.parse(json.stdout).unexcluded).toEqual({count: 1, paths: ["pnpm-lock.yaml"]});
	});

	it("carries the removal into --emit-diff's header, after the excluded paths", async () => {
		const out = await runOverConfig(
			[],
			{
				reviewFilterExclusions: ["**/cart.ts"],
				reviewFilterUnexclude: ["pnpm-lock.yaml"],
			},
			{diffFile: diffOnDisk(LOCK_DIFF), filterPlacement: "after", emitDiff: true},
		);
		expect(out.code).toBe(0);
		const lines = out.stdout.split("\n");
		expect(lines[0]).toBe("x-fabrika-filter: placement=after excluded=1 served=1");
		expect(lines[1]).toBe("x-fabrika-excluded-path: src/cart.ts");
		expect(lines[2]).toBe("x-fabrika-unexcluded-path: pnpm-lock.yaml");
		expect(out.stdout).toContain("+  effect:");
	});

	it("does not enumerate a default an equal addition re-added", async () => {
		const out = await runOverConfig(
			PR_LOCK,
			{reviewFilterExclusions: ["pnpm-lock.yaml"], reviewFilterUnexclude: ["pnpm-lock.yaml"]},
			{pr: PR},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("excluded-path\tpnpm-lock.yaml");
		expect(out.stdout).not.toContain("un-excluded");
	});

	it("refuses an undecodable exclusion key on 11, before any subject read the set would turn on", async () => {
		const out = await runOverConfig(prGreen(), {reviewFilterExclusions: "src/**"}, {pr: PR});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain(
			"`reviewFilterExclusions` is not an array of pattern strings",
		);
	});

	it("refuses a removal naming a non-default on 11", async () => {
		const out = await runOverConfig(
			rangeGreen(),
			{reviewFilterUnexclude: ["dist/**"]},
			RANGE_SUBJECT,
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('"dist/**" is not a shipped default exclusion');
	});
});

/**
 * The runtime backstop, verb-level.
 *
 * previewOf refuses on its own when the split actually excluded a governed path — the
 * pattern-level arms refuse only what a pattern forces, and a leading-double-star suffix glob
 * slips past both. The verb's seat maps that refusal to GOVERNED_FILTER, and the detail words it
 * through excludedPath, naming the path that was really carved out.
 */
describe("runPreview refuses a filter that excludes governed content", () => {
	const GOVERNED_DIFF = `diff --git a/governed/cart.ts b/governed/cart.ts
--- a/governed/cart.ts
+++ b/governed/cart.ts
@@ -1,1 +1,2 @@
+const items = read();
`;
	const roots = ["governed/", ".fabrika.jsonc"];

	it("refuses on 21 when the --diff-file's only section sits under a governed root", async () => {
		const out = await runOverRoots([], roots, {
			diffFile: diffOnDisk(GOVERNED_DIFF),
			exclude: "**/*.ts",
		});
		expect(out.code).toBe(GOVERNED_FILTER);
		expect(out.stdout).toBe("");
		// `previewOf` refuses internally, so the verb's lead-in stays the pattern-level sentence and
		// only the detail carries the runtime words — `excludedPath` marks the backstop row.
		expect(out.stderr.join("\n")).toContain('"**/*.ts" excludes governed path "governed/cart.ts"');
	});

	it("lets the filter exclude non-governed paths beside a declared governed root", async () => {
		const out = await runOverRoots([], roots, {
			diffFile: diffOnDisk(),
			exclude: "README.md",
		});
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("excluded-path\tREADME.md");
		expect(out.stdout).not.toContain("excludes governed path");
	});
});

describe("preview requirement parity", () => {
	it("uses configured UI prefixes and governed roots over all raw paths", async () => {
		const changed = ["screens/View.tsx", "policy/rule.md", "pnpm-lock.yaml"];
		const diff = changed.map((path) => `diff --git a/${path} b/${path}\n+changed`).join("\n");
		const config = {
			governedRoots: [".fabrika.jsonc", "policy/"],
			uiSurfaces: [
				{name: "screen", prefix: "screens/", mount: "/", command: "pnpm dev --port {{port}}"},
			],
		};
		const out = await Effect.runPromise(
			Effect.provide(
				runPreview({...options, pr: PR, json: true, exclude: "screens/**"}),
				Layer.merge(
					fakeSeams(prGreen(diff, changed)).layer,
					fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify(config)}}).layer,
				),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).namespaces).toEqual([
			"review-code",
			"review-doc",
			"review-ui",
			"governance",
		]);
		expect(JSON.parse(out.stdout).excluded.paths).toEqual(["screens/View.tsx", "pnpm-lock.yaml"]);
	});
	it("retains code review when all content is excluded", async () => {
		const diff = "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n+changed";
		const out = await run(prGreen(diff, ["pnpm-lock.yaml"]), {pr: PR, json: true});
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			matched_paths: [],
			namespaces: ["review-code"],
			excluded: {count: 1, paths: ["pnpm-lock.yaml"]},
		});
	});
});
