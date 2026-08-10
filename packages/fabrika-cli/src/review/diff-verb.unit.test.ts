import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	INCOMPLETE_SCAN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	STALE_HEAD,
	ZERO_SCOPE,
} from "./codes.ts";
import {runDiff} from "./diff-verb.ts";
import {
	binding,
	DIFF,
	DIFF_AT,
	HEAD,
	OLD_HEAD,
	PATHS_AT,
	paths,
	pull,
} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
/** The unbound endpoint this verb no longer reads — scripted so a regression has bytes to serve. */
const RAW = /^gh api -H Accept: application\/vnd\.github\.diff repos\/o\/r\/pulls\/4321$/;

/** What that endpoint would hand back mid-flight: a *different* head's diff, one file wide. */
const MOVED_DIFF = `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,1 +1,2 @@
 const x = 1;
+const y = 2;
`;

const options = {
	pr: 4321,
	sha: null as string | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const shell = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => {
	const fake = fakeShell(script);
	return {
		fake,
		out: Effect.runPromise(Effect.provide(runDiff({...options, ...overrides}), fake.layer)),
	};
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => shell(script, overrides).out;

/**
 * The whole green path: the PR read, the four binding reads, the diff at the bound commit, and the
 * `--name-only` read of the SAME range that the completeness proof is taken against.
 */
const green = (
	diff: string = DIFF,
	shape: Parameters<typeof pull>[0] = {},
	inRange: ReadonlyArray<string> = ["src/cart.ts", "README.md"],
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull(shape)],
	...binding(),
	[DIFF_AT(), okOut(diff)],
	[PATHS_AT(), paths(...inRange)],
	[RAW, okOut(MOVED_DIFF)],
];

/** A rename git pairs into ONE `diff --git` entry — the shape GitHub may count as two files. */
const RENAME_DIFF = `diff --git a/src/old.ts b/src/new.ts
similarity index 96%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,1 +1,2 @@
 const x = 1;
+const y = 2;
`;

describe("runDiff", () => {
	it("serves the diff bytes exactly as the object database holds them", async () => {
		const out = await run(green());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(DIFF);
	});

	it("reports the commit it bound to and the counts it proved the diff against", async () => {
		const out = await run(green());
		expect(out.stderr[0]).toBe(
			`review diff: bound to ${HEAD} (base 0f1e2d3c4b5a69788796a5b4c3d2e1f009182736) — read from the object database, nothing checked out.`,
		);
		expect(out.stderr[1]).toContain(
			"scanned 2 files; 2 in the range per git, 2 declared by GitHub",
		);
		expect(out.stderr[1]).toContain("bytes");
	});

	it("refuses a diff short of the range's own file list on 13 rather than serving the prefix as the whole", async () => {
		const out = await run(green(DIFF, {}, ["src/cart.ts", "README.md", "src/dropped.ts"]));
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`review diff: the diff at ${HEAD} carries 2 of the 3 files git reports for the same range 0f1e2d3c4b5a69788796a5b4c3d2e1f009182736...${HEAD} — both counts from git, so this diff is provably short; refusing to serve a partial diff as the whole (#3925's class).`,
		);
	});

	it("refuses on 11 when the range's file list cannot be read, rather than proving completeness against nothing", async () => {
		const out = await run([
			[PULL, pull()],
			...binding(),
			[DIFF_AT(), okOut(DIFF)],
			[PATHS_AT(), errOut("fatal: bad revision")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot read the file list of the range");
	});

	it("makes the same zero-file refusal `review scope` does, so neither serves a review over nothing", async () => {
		const out = await run([[PULL, pull({changedFiles: 0})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain(
			"refusing to serve an empty diff as a reviewable one (ADR 0092).",
		);
	});

	it("refuses an absent PR on 7 and an unreadable diff on 11", async () => {
		expect((await run([[PULL, errOut("gh: Not Found (HTTP 404)")]])).code).toBe(ZERO_SCOPE);
		const unreadable = await run([
			[PULL, pull()],
			...binding(),
			[DIFF_AT(), errOut("fatal: bad object")],
		]);
		expect(unreadable.code).toBe(PRECONDITION_UNKNOWN);
		expect(unreadable.stdout).toBe("");
		expect(unreadable.stderr.at(-1)).toContain("UNKNOWN");
	});
});

/**
 * The single-source fence (#5139).
 *
 * Both operands of the exit-`13` inequality are produced by git over one range under one set of
 * flags. Each case here fails if the denominator drifts back to GitHub's `changed_files`, whose
 * merge base and rename detection are its own.
 */
describe("runDiff proves completeness against git's own count", () => {
	it("serves a rename git paired into one entry, though GitHub declares it as two files", async () => {
		const out = await run(green(RENAME_DIFF, {changedFiles: 2}, ["src/new.ts"]));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(RENAME_DIFF);
	});

	it("reports the git-vs-GitHub disagreement on stderr instead of refusing on it", async () => {
		const out = await run(green(RENAME_DIFF, {changedFiles: 2}, ["src/new.ts"]));
		expect(out.stderr.at(-1)).toBe(
			"review diff: git and GitHub disagree on #4321's file count (1 vs 2) — different merge base and different rename detection; reported, never refused on (#5139).",
		);
	});

	it("takes both counts from the same range, and never from the PR's declared count", async () => {
		const {fake, out} = shell(green());
		await out;
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ --name-only -z 0f1e2d3c4b5a69788796a5b4c3d2e1f009182736...${HEAD}`,
		);
	});
});

/**
 * The provenance fence (#5117).
 *
 * Each case here fails if the read reverts to the PR-number endpoint: that endpoint is scripted in
 * every green fixture and serves a *different* head's bytes, so an unbound read does not error — it
 * answers, plausibly and wrongly. That is the whole hazard, so it is the whole assertion.
 */
describe("runDiff binds its bytes to a commit", () => {
	it("reads the object database and never the PR-number diff endpoint", async () => {
		const {fake, out} = shell(green());
		const result = await out;
		expect(result.stdout).toBe(DIFF);
		expect(result.stdout).not.toContain("src/other.ts");
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ 0f1e2d3c4b5a69788796a5b4c3d2e1f009182736...${HEAD}`,
		);
		expect(fake.calls.some((c) => c.includes("vnd.github.diff"))).toBe(false);
	});

	it("serves the scoped commit's bytes through a rewind, which the post-time re-resolve passes clean", async () => {
		// A push landed and was rewound back onto HEAD: the live head still equals --sha, so `review
		// post`'s STALE_HEAD never fires — only a read taken AT the commit survives this.
		const {fake, out} = shell(green(), {sha: HEAD});
		const result = await out;
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(DIFF);
		expect(fake.calls.some((c) => c.includes("vnd.github.diff"))).toBe(false);
	});

	it("refuses on 12 when --sha is not the PR's head, instead of reading whatever is live", async () => {
		const {fake, out} = shell(green(), {sha: OLD_HEAD});
		const result = await out;
		expect(result.code).toBe(STALE_HEAD);
		expect(result.stdout).toBe("");
		expect(result.stderr.at(-1)).toBe(
			`review diff: PR #4321's head is ${HEAD}, not ${OLD_HEAD} — the tree you scoped is not the one under review; re-scope at ${HEAD} (ADR 0058).`,
		);
		expect(fake.calls.some((c) => c.startsWith("git diff"))).toBe(false);
	});

	it("refuses a --sha that is not a head SHA on 10", async () => {
		const out = await run(green(), {sha: "HEAD~1"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("is not a head SHA");
	});

	it("refuses on 11 when no remote in this checkout serves the target repo", async () => {
		const out = await run([
			[PULL, pull()],
			[/^git remote -v$/, okOut("origin\tgit@github.com:someone/else.git (fetch)\n")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toBe(
			"review diff: no git remote in this checkout serves o/r — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.",
		);
	});

	it("refuses on 11 when the head cannot be fetched, rather than reading a stale object database", async () => {
		// The override goes FIRST: `fakeShell` answers with the first matching row, so a row placed
		// after the green binding would never be reached.
		const out = await run([
			[PULL, pull()],
			[/^git fetch --quiet origin pull\/4321\/head$/, errOut("couldn't find remote ref")],
			...binding(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot fetch pull/4321/head from origin");
	});

	it("refuses on 11 when git resolves the head to a different commit", async () => {
		// A local ref or tag spelled as hex resolves elsewhere — a name that verifies and still names
		// the wrong tree, which is why the resolved object name is compared against the one asked for.
		const out = await run([
			[PULL, pull()],
			[
				new RegExp(`^git rev-parse --verify --quiet ${HEAD}\\^\\{commit\\}$`),
				okOut(`${OLD_HEAD}\n`),
			],
			...binding(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(`git resolved ${HEAD} to ${OLD_HEAD}, a different commit`);
	});

	it("refuses on 11 when the base end of the range will not resolve", async () => {
		const out = await run([
			[PULL, pull()],
			[/^git fetch --quiet origin main$/, errOut("couldn't find remote ref main")],
			...binding(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot resolve base main");
	});
});
