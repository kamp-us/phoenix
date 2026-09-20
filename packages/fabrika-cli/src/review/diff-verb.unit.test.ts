import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	fakeFs,
	fakeSeams,
	type HttpReply,
	okOut,
	type Scripted,
	unconfigured,
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
import {runDiff} from "./diff-verb.ts";
import type {FilterPlacement} from "./filter-spike.ts";
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

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321$/;
const NOT_FOUND = '{"message":"Not Found"}';

/** A canned payload as the platform serves it — the fixtures speak `ExecResult`, the seam HTTP. */
const served = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

/**
 * How many times the run asked GitHub for `pulls/4321`.
 *
 * The unbound diff read this verb must never make is that same URL under a diff `Accept`, so the
 * two are one line at the HTTP seam and only the count tells them apart: one read is the metadata
 * read every run makes, two is the PR-number diff read coming back.
 */
const pullReads = (requests: ReadonlyArray<string>): number =>
	requests.filter((request) => PULL.test(request)).length;

/**
 * How many requests carried a diff `Accept` — the unbound read's only distinguishing mark.
 *
 * The diff read and the metadata read are the same URL, so `requests` alone cannot tell them apart;
 * the `Accept` header is the one place the difference is stated, and this holds the fence's original
 * claim rather than inferring it from a count.
 */
const diffAcceptReads = (fake: {
	readonly requests: ReadonlyArray<string>;
	readonly headers: ReadonlyArray<Readonly<Record<string, string>>>;
}): number =>
	fake.requests.filter((_, i) => (fake.headers[i]?.accept ?? "").includes("vnd.github.diff"))
		.length;

const options = {
	pr: 4321,
	sha: null as string | null,
	repo: null,
	/** ocr-port spike fields, null = off — the overrides below turn them on per case. */
	filterPlacement: null as FilterPlacement | null,
	exclude: null as string | null,
	cwd: "/repo",
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const shell = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const fake = fakeSeams(script);
	return {
		fake,
		// The config arms of the exclusion set are part of the verb's reads now, so every run stands
		// on the unconfigured checkout unless a case layers a declared `.fabrika.jsonc` over it.
		out: Effect.runPromise(
			Effect.provide(runDiff({...options, ...overrides}), Layer.merge(fake.layer, unconfigured)),
		),
	};
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	shell(script, overrides).out;

/**
 * The whole green path: the PR read, the four binding reads, the diff at the bound commit, and the
 * `--name-only` read of the SAME range that the completeness proof is taken against.
 */
const green = (
	diff: string = DIFF,
	shape: Parameters<typeof pull>[0] = {},
	inRange: ReadonlyArray<string> = ["src/cart.ts", "README.md"],
): ReadonlyArray<Scripted> => [
	[PULL, served(pull(shape))],
	...binding(),
	[DIFF_AT(), okOut(diff)],
	[PATHS_AT(), paths(...inRange)],
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
			`review diff: the diff at ${HEAD} carries 2 of the 3 files git reports for the same range 0f1e2d3c4b5a69788796a5b4c3d2e1f009182736...${HEAD} — both counts from git, so this diff is provably short; refusing to serve a partial diff as the whole.`,
		);
	});

	it("refuses on 11 when the range's file list cannot be read, rather than proving completeness against nothing", async () => {
		const out = await run([
			[PULL, served(pull())],
			...binding(),
			[DIFF_AT(), okOut(DIFF)],
			[PATHS_AT(), errOut("fatal: bad revision")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot read the file list of the range");
	});

	it("makes the same zero-file refusal `review scope` does, so neither serves a review over nothing", async () => {
		const out = await run([[PULL, served(pull({changedFiles: 0}))]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("refusing to serve an empty diff as a reviewable one.");
	});

	it("refuses an absent PR on 7 and an unreadable diff on 11", async () => {
		expect((await run([[PULL, {status: 404, body: NOT_FOUND}]])).code).toBe(ZERO_SCOPE);
		const unreadable = await run([
			[PULL, served(pull())],
			...binding(),
			[DIFF_AT(), errOut("fatal: bad object")],
		]);
		expect(unreadable.code).toBe(PRECONDITION_UNKNOWN);
		expect(unreadable.stdout).toBe("");
		expect(unreadable.stderr.at(-1)).toContain("UNKNOWN");
	});
});

/**
 * The single-source fence.
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
			"review diff: git and GitHub disagree on #4321's file count (1 vs 2) — different merge base and different rename detection; reported, never refused on.",
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
 * The provenance fence.
 *
 * Each case here fails if the read reverts to the PR-number endpoint: that read does not error, it
 * answers with whatever head the platform is serving right now — plausibly and wrongly. That is the
 * whole hazard, so it is the whole assertion, counted through {@link pullReads}.
 */
describe("runDiff binds its bytes to a commit", () => {
	it("reads the object database and never the PR-number diff endpoint", async () => {
		const {fake, out} = shell(green());
		const result = await out;
		expect(result.stdout).toBe(DIFF);
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ 0f1e2d3c4b5a69788796a5b4c3d2e1f009182736...${HEAD}`,
		);
		expect(pullReads(fake.requests)).toBe(1);
		expect(diffAcceptReads(fake)).toBe(0);
	});

	it("serves the scoped commit's bytes through a rewind, which the post-time re-resolve passes clean", async () => {
		// A push landed and was rewound back onto HEAD: the live head still equals --sha, so `review
		// post`'s STALE_HEAD never fires — only a read taken AT the commit survives this.
		const {fake, out} = shell(green(), {sha: HEAD});
		const result = await out;
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(DIFF);
		expect(pullReads(fake.requests)).toBe(1);
		expect(diffAcceptReads(fake)).toBe(0);
	});

	it("refuses on 12 when --sha is not the PR's head, instead of reading whatever is live", async () => {
		const {fake, out} = shell(green(), {sha: OLD_HEAD});
		const result = await out;
		expect(result.code).toBe(STALE_HEAD);
		expect(result.stdout).toBe("");
		expect(result.stderr.at(-1)).toBe(
			`review diff: PR #4321's head is ${HEAD}, not ${OLD_HEAD} — the tree you scoped is not the one under review; re-scope at ${HEAD}.`,
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
			[PULL, served(pull())],
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
			[PULL, served(pull())],
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
			[PULL, served(pull())],
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
			[PULL, served(pull())],
			[/^git fetch --quiet origin main$/, errOut("couldn't find remote ref main")],
			...binding(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("cannot resolve base main");
	});
});

/**
 * The exclusion set's config arms.
 *
 * `reviewFilterExclusions` extends the effective set, `reviewFilterUnexclude` removes a shipped
 * default. A removal is stated twice — an `x-fabrika-unexcluded-path` line in the served diff's
 * header and an `unexcluded=` count in the diagnostic — so a narrowed filter is never silent, and
 * with both keys empty the served bytes are byte-identical to a run that never read them.
 */
describe("runDiff's exclusion set reads .fabrika.jsonc", () => {
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
	const placement = {filterPlacement: "after" as const, exclude: "README.md"};
	const configured = (config: Record<string, unknown>) =>
		Layer.merge(
			fakeSeams(green()).layer,
			fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify(config)}}).layer,
		);

	it("serves byte-identical bytes and the same diagnostic when the keys are absent, empty, or the file declares none", async () => {
		const plain = await run(green(), placement);
		const braces = await Effect.runPromise(
			Effect.provide(runDiff({...options, ...placement}), configured({})),
		);
		const empty = await Effect.runPromise(
			Effect.provide(
				runDiff({...options, ...placement}),
				configured({reviewFilterExclusions: [], reviewFilterUnexclude: []}),
			),
		);
		expect(braces.stdout).toBe(plain.stdout);
		expect(braces.stderr).toEqual(plain.stderr);
		expect(empty.stdout).toBe(plain.stdout);
		expect(empty.stderr).toEqual(plain.stderr);
		// The filter itself ran in all three — one CLI exclusion, no un-excluded count anywhere.
		expect(plain.stdout).toContain("x-fabrika-filter: placement=after excluded=1 served=1");
		expect(plain.stdout).toContain("x-fabrika-excluded-path: README.md");
		expect(plain.stdout).not.toContain("x-fabrika-unexcluded-path");
		expect(plain.stderr.at(-1)).toContain("excluded=1 served=1 of 2 files");
		expect(plain.stderr.at(-1)).not.toContain("unexcluded=");
	});

	it("extends the exclusion set with the declared globs", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runDiff({...options, ...placement}),
				Layer.merge(
					fakeSeams(green()).layer,
					fakeFs({
						files: {
							"/repo/.fabrika.jsonc": JSON.stringify({reviewFilterExclusions: ["**/cart.ts"]}),
						},
					}).layer,
				),
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("x-fabrika-filter: placement=after excluded=2 served=0");
		expect(out.stdout).toContain("x-fabrika-excluded-path: src/cart.ts");
		expect(out.stderr.at(-1)).toContain("excluded=2 served=0 of 2 files");
	});

	it("names a removed default in the header and the diagnostic, and serves its bytes", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runDiff({...options, filterPlacement: "after", cwd: "/repo"}),
				Layer.merge(
					fakeSeams(green(LOCK_DIFF, {}, ["src/cart.ts", "pnpm-lock.yaml"])).layer,
					fakeFs({
						files: {
							"/repo/.fabrika.jsonc": JSON.stringify({reviewFilterUnexclude: ["pnpm-lock.yaml"]}),
						},
					}).layer,
				),
			),
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("x-fabrika-filter: placement=after excluded=0 served=2");
		expect(out.stdout).toContain("x-fabrika-unexcluded-path: pnpm-lock.yaml");
		expect(out.stdout).toContain("+  effect:");
		expect(out.stderr.at(-1)).toContain("unexcluded=1");
	});

	it("refuses an undecodable exclusion key on 11", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runDiff({...options, ...placement}),
				configured({reviewFilterExclusions: "src/**"}),
			),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain(
			"`reviewFilterExclusions` is not an array of pattern strings",
		);
	});

	it("refuses a removal naming a non-default on 11 — only a default's exact pattern may be removed", async () => {
		const out = await Effect.runPromise(
			Effect.provide(
				runDiff({...options, ...placement}),
				configured({reviewFilterUnexclude: ["dist/**"]}),
			),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('"dist/**" is not a shipped default exclusion');
	});
});

/**
 * The runtime backstop.
 *
 * The pattern-level arms refuse only what a pattern forces; a leading-double-star suffix glob
 * slips past both while still carving governed content out of the served diff. What closes the
 * rest of the contract is the exclusion itself: when the split actually excluded a path under a
 * governed root, the verb refuses instead of serving a diff that no longer holds everything. The
 * governed roots ride options.governedRoots, read by the adapter exactly as the verb reads them.
 */
describe("runDiff refuses a filter that excludes governed content", () => {
	const GOVERNED_DIFF = `diff --git a/governed/cart.ts b/governed/cart.ts
--- a/governed/cart.ts
+++ b/governed/cart.ts
@@ -1,1 +1,2 @@
+const items = read();
diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,1 +1,2 @@
+const extra = 1;
`;
	const governedRoots = ["governed/"];

	/** The layer a governed-roots case runs over — the adapter hands the verb these roots. */
	const runOverRoots = (
		script: ReadonlyArray<Scripted>,
		roots: ReadonlyArray<string>,
		overrides: Partial<typeof options> = {},
	) =>
		Effect.runPromise(
			Effect.provide(
				runDiff({...options, ...overrides, governedRoots: roots}),
				Layer.merge(fakeSeams(script).layer, unconfigured),
			),
		);

	it("refuses on 21 when the split actually excluded a governed-rooted path", async () => {
		const out = await runOverRoots(
			green(GOVERNED_DIFF, {}, ["governed/cart.ts", "src/cart.ts"]),
			governedRoots,
			{
				filterPlacement: "after",
				exclude: "**/*.ts",
			},
		);
		expect(out.code).toBe(GOVERNED_FILTER);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("the filter excludes governed content");
		expect(out.stderr.join("\n")).toContain('"**/*.ts" excludes governed path "governed/cart.ts"');
	});

	it("serves a filter whose exclusions are all non-governed beside a declared governed root", async () => {
		const out = await runOverRoots(green(), governedRoots, {
			filterPlacement: "after",
			exclude: "README.md",
		});
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("x-fabrika-filter: placement=after excluded=1 served=1");
		expect(out.stdout).not.toContain("excludes governed path");
	});
});

describe("diff reads filter configuration only when filtering", () => {
	it.each([
		{reviewFilterExclusions: "src/**"},
		{reviewFilterUnexclude: ["not-a-default"]},
		{governedRoots: []},
	])("ignores unused malformed configuration %j", async (config) => {
		const read = (filterPlacement: FilterPlacement | null) =>
			Effect.runPromise(
				Effect.provide(
					runDiff({...options, filterPlacement}),
					Layer.merge(
						fakeSeams(green()).layer,
						fakeFs({files: {"/repo/.fabrika.jsonc": JSON.stringify(config)}}).layer,
					),
				),
			);
		const baseline = await run(green());
		const unfiltered = await read(null);
		const filtered = await read("after");
		expect(unfiltered).toEqual(baseline);
		expect(filtered.code).toBe(PRECONDITION_UNKNOWN);
		expect(filtered.stdout).toBe("");
	});
	it("serves unfiltered content when config is unreadable, but refuses filtering", async () => {
		const read = (filterPlacement: FilterPlacement | null) =>
			Effect.runPromise(
				Effect.provide(
					runDiff({...options, filterPlacement}),
					Layer.merge(
						fakeSeams(green()).layer,
						fakeFs({files: {"/repo/.fabrika.jsonc": "{}"}, unreadable: ["/repo/.fabrika.jsonc"]})
							.layer,
					),
				),
			);
		const baseline = await run(green());
		const unfiltered = await read(null);
		const filtered = await read("after");
		expect(unfiltered).toEqual(baseline);
		expect(filtered.code).toBe(PRECONDITION_UNKNOWN);
	});
});
