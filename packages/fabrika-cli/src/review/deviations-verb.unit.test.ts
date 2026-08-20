import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, type HttpReply, okOut, type Scripted} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	INCOMPLETE_SCAN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	STALE_HEAD,
	ZERO_SCOPE,
} from "./codes.ts";
import {runDeviations} from "./deviations-verb.ts";
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

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321$/;
const NOT_FOUND = '{"message":"Not Found"}';

/** A canned payload as the platform serves it — the fixtures speak `ExecResult`, the seam HTTP. */
const served = (result: ExecResult, status = 200): HttpReply => ({status, body: result.stdout});

/**
 * How many times the run asked GitHub for `pulls/4321`.
 *
 * The unbound diff read this verb must never make is that same URL under a diff `Accept`, so the
 * two are one line at the HTTP seam and only the count tells them apart: one read is the metadata
 * read every run makes, two is the PR-number diff read coming back (#5122).
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

const SUPPRESSING_DIFF = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -10,1 +10,2 @@
 const items = read();
+// @ts-expect-error the types are wrong
diff --git a/src/cart.test.ts b/src/cart.test.ts
--- a/src/cart.test.ts
+++ b/src/cart.test.ts
@@ -12,2 +12,1 @@
 it("renders", () => {
-		expect(renderTotal(10)).toBe("10.00");
`;

const options = {
	pr: 4321,
	sha: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const shell = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const fake = fakeSeams(script);
	return {
		fake,
		out: Effect.runPromise(Effect.provide(runDeviations({...options, ...overrides}), fake.layer)),
	};
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	shell(script, overrides).out;

/**
 * The green path: the bound range serves `diff`, and the same range's `--name-only` read serves
 * `inRange` — the completeness denominator.
 */
const scripted = (
	diff: string,
	shape: Parameters<typeof pull>[0] = {},
	inRange: ReadonlyArray<string> = ["src/cart.ts", "README.md"],
): ReadonlyArray<Scripted> => [
	[PULL, served(pull(shape))],
	...binding(),
	[DIFF_AT(), okOut(diff)],
	[PATHS_AT(), paths(...inRange)],
];

const happy = (shape: Parameters<typeof pull>[0] = {}) => scripted(DIFF, shape);

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

describe("runDeviations", () => {
	it("prints none-declared for a `None.` body with a clean diff", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("deviations\tnone-declared\n");
	});

	it("makes a falsified `None.` visible in one read — the claim beside the hits", async () => {
		const out = await run(scripted(SUPPRESSING_DIFF));
		expect(out.stdout).toBe(
			[
				"deviations\tnone-declared",
				"tier-m\tsuppression\tsrc/cart.ts:11\t@ts-expect-error",
				'tier-m\tremoved-assertion\tsrc/cart.test.ts:13\texpect(renderTotal(10)).toBe("10.00");',
				"",
			].join("\n"),
		);
	});

	it("prints an entry's label and the first line of its Said", async () => {
		const body =
			"## Deviations\n\n- **Pre-existing test or fixture changed** — **Said:** replaced the two-decimal rendering assertion. **Did:** dropped it. **Why:** it asserted the defect. **Disposition:** stated here.";
		const out = await run(happy({body}));
		expect(out.stdout).toBe(
			["deviations\tfound", "entry\t6\treplaced the two-decimal rendering assertion.", ""].join(
				"\n",
			),
		);
	});

	it("keeps absent distinct from none-declared — the skill's verdict depends on it", async () => {
		const out = await run(happy({body: "Fixes #4287\n"}));
		expect(out.stdout).toBe("deviations\tabsent\n");
	});

	it("refuses a diff short of the range's own file list on 13 — a partial scan must not print beside a claim", async () => {
		const out = await run(scripted(DIFF, {}, ["src/cart.ts", "README.md", "src/dropped.ts"]));
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`review deviations: the scan at ${HEAD} covers 2 of the 3 files git lists for the same range ${BASE}...${HEAD} — both counts from git, so these bytes are provably short of the range they were read from; refusing a partial Tier-M scan beside a disclosure claim.`,
		);
	});

	it("refuses on 11 when the range's file list cannot be read, rather than scanning against nothing", async () => {
		const out = await run([
			[PULL, served(pull())],
			...binding(),
			[DIFF_AT(), okOut(DIFF)],
			[PATHS_AT(), errOut("fatal: bad revision")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("cannot read the file list of the range");
		expect(out.stderr.at(-1)).toContain('the disclosure state is UNKNOWN, never "none"');
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, {status: 404, body: NOT_FOUND}]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review deviations: PR #4321 not found in o/r.");
	});

	it("refuses an unreadable body or diff on 11, and never answers `none`", async () => {
		for (const script of [
			[[PULL, {status: 502, body: "{}"}]] as const,
			[[PULL, served(pull())], ...binding(), [DIFF_AT(), errOut("fatal: bad revision")]] as const,
		]) {
			const out = await run(script as ReadonlyArray<Scripted>);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toContain('the disclosure state is UNKNOWN, never "none"');
		}
	});
});

/**
 * The single-source fence (#5157).
 *
 * The exit-`13` denominator is git's own count over the bound range, not GitHub's `changed_files`.
 * Each case fails if the denominator drifts back across the system boundary, where a rename git
 * pairs into one entry and the platform declares two.
 */
describe("runDeviations proves its scan complete against git's own count", () => {
	const renamed = () => scripted(RENAME_DIFF, {changedFiles: 2}, ["src/new.ts"]);

	it("scans a rename git paired into one entry, though GitHub declares it as two files", async () => {
		const out = await run(renamed());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("deviations\tnone-declared\n");
	});

	it("reports the git-vs-GitHub disagreement on stderr instead of refusing on it", async () => {
		const out = await run(renamed());
		expect(out.stderr.at(-1)).toBe(
			"review deviations: git and GitHub disagree on #4321's file count (1 vs 2) — different merge base and different rename detection; reported, never refused on (#5157).",
		);
	});

	it("takes the denominator from the same range as the diff it scans", async () => {
		const {fake, out} = shell(happy());
		await out;
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ --name-only -z ${BASE}...${HEAD}`,
		);
	});
});

/**
 * The provenance fence (#5122), the sibling of `review scope`'s.
 *
 * A `deviation-disclosure` verdict claims "nothing undisclosed that this gate could see", so the hit
 * list is not one input among many — read at a head nobody scoped it is under- or over-reported
 * beside the disclosure it is printed next to, and the caller reads a checked-clean answer at exit 0.
 * A read that reverted to the PR-number endpoint would answer with whatever head the platform is
 * serving right now — a **wrong answer**, not a crash — so every case below counts that URL's reads
 * through {@link pullReads} and holds it at the one metadata read.
 */
describe("runDeviations binds its Tier-M scan to a commit", () => {
	it("scans the bound commit's bytes, never the PR-number endpoint's", async () => {
		const {fake, out} = shell(scripted(SUPPRESSING_DIFF));
		const result = await out;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("tier-m\tsuppression\tsrc/cart.ts:11\t@ts-expect-error");
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ ${BASE}...${HEAD}`,
		);
		expect(pullReads(fake.requests)).toBe(1);
		expect(diffAcceptReads(fake)).toBe(0);
	});

	// The fail-OPEN direction, and the reason this is priced above its fail-closed sibling: the
	// unbound read answers `none-declared` with an empty hit list beside a `None.` body, at exit 0.
	it("does not print a clean scan beside a `None.` when the endpoint's head is the clean one", async () => {
		const out = await run(scripted(SUPPRESSING_DIFF));
		expect(out.stdout).not.toBe("deviations\tnone-declared\n");
	});

	// The hole `12` cannot close: the head moved forward and was force-pushed back, so `--sha` IS the
	// live head and every staleness check passes — while the PR-number endpoint still serves the
	// intermediate head's bytes. Only reading at the commit tells the two trees apart.
	it("scans the recorded commit after a REWIND back onto it, not what the endpoint serves", async () => {
		const {fake, out} = shell(scripted(SUPPRESSING_DIFF), {sha: HEAD});
		const result = await out;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("tier-m\tremoved-assertion");
		expect(pullReads(fake.requests)).toBe(1);
		expect(diffAcceptReads(fake)).toBe(0);
	});

	it("reports the commit it bound to, ahead of what it scanned", async () => {
		const out = await run(happy());
		expect(out.stderr[0]).toBe(
			`review deviations: bound to ${HEAD} (base ${BASE}) — read from the object database, nothing checked out.`,
		);
		expect(out.stderr[1]).toBe(
			"review deviations: scanned 2 files; 2 in the range per git, 2 declared by GitHub.",
		);
	});

	it("refuses on 12 when --sha is not the PR's head, scanning nothing", async () => {
		const {fake, out} = shell(happy(), {sha: OLD_HEAD});
		const result = await out;
		expect(result.code).toBe(STALE_HEAD);
		expect(result.stdout).toBe("");
		expect(result.stderr.at(-1)).toContain("re-scope at");
		expect(fake.calls.some((c) => c.startsWith("git diff"))).toBe(false);
	});

	it("refuses a --sha that is not a head SHA on 10", async () => {
		const out = await run(happy(), {sha: "origin/main"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toContain("is not a head SHA");
	});

	it("refuses on 11 when the commit cannot be bound, rather than scanning an unbound diff", async () => {
		const out = await run([
			[PULL, served(pull())],
			[/^git remote -v$/, okOut("origin\tgit@github.com:someone/else.git (fetch)\n")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review deviations: no git remote in this checkout serves o/r — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.",
		);
	});
});
