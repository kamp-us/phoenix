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
import {
	BASE,
	BASE_TIP,
	binding,
	files,
	HEAD,
	OLD_HEAD,
	PATHS_AT,
	paths,
	pull,
} from "./fixtures.test-support.ts";
import {runScope} from "./scope-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
/** The unbound endpoint this verb no longer reads — scripted so a regression has a list to serve. */
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;

const options = {
	pr: 4321,
	sha: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const shell = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => {
	const fake = fakeShell(script);
	return {
		fake,
		out: Effect.runPromise(Effect.provide(runScope({...options, ...overrides}), fake.layer)),
	};
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => shell(script, overrides).out;

/**
 * The green path. The PR-number files endpoint is scripted too, and deliberately answers a
 * *different* file set — so a read that drifts back to it derives `review-doc` where the bound
 * commit derives both classes, instead of failing loudly.
 */
const happy = (
	shape: Parameters<typeof pull>[0] = {},
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull(shape)],
	...binding(),
	[PATHS_AT(), paths("src/cart.ts", "README.md")],
	[FILES, files("docs/moved.md", "docs/also.md")],
];

describe("runScope", () => {
	it("prints the head, the linked issue, the present classes, the flags and the governance token", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`scoped\t${HEAD}\tfixes:4287`,
				"class\tcode\t1",
				"class\tdoc\t1",
				"self\tfalse",
				"harness\tfalse",
				"governance\tnot-required",
				"",
			].join("\n"),
		);
	});

	it("emits the record with --json, including the derived namespace set", async () => {
		const out = await run(happy(), {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "scoped",
			head: HEAD,
			issue: {kind: "fixes", number: 4287},
			scanned: 2,
			governance: "not-required",
			namespaces: ["review-code", "review-doc"],
		});
	});

	/**
	 * The governance line is the four-root derivation, not the three-root `harness` flag (#5607): a
	 * `.decisions/`-only diff owes a governance verdict while touching no harness root, and a reviewer
	 * keying off `harness` posted a clean PASS on PR #5604 that the ship gate then blocked.
	 */
	it("prints `governance required` on a `.decisions/`-only diff, where `harness` is false", async () => {
		const out = await run([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), paths(".decisions/0280-review-shell-carries-the-spawn-tool.md")],
			[FILES, files("docs/moved.md")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("harness\tfalse");
		expect(out.stdout).toContain("governance\trequired");
	});

	it("keeps the two answers apart on a harness diff — both roots, both tokens", async () => {
		const out = await run([
			[PULL, pull()],
			...binding(),
			[PATHS_AT(), paths(".github/workflows/ci.yml")],
			[FILES, files("docs/moved.md")],
		]);
		expect(out.stdout).toContain("harness\ttrue");
		expect(out.stdout).toContain("governance\trequired");
	});

	it("prints `-` for a PR with neither marker, never a fabricated issue", async () => {
		const out = await run(happy({body: "relates to #4287"}));
		expect(out.stdout.split("\n")[0]).toBe(`scoped\t${HEAD}\t-`);
	});
});

/**
 * The partial-split fence (#5446).
 *
 * `build --partial` emits `Part of #N` by contract and `ship scope` reads it, so a `NULL` here left
 * the gate's acceptance-criteria step with no issue to grade against and no instruction for the
 * state. These cases fail if `review scope` drifts back to the closing keyword alone.
 */
describe("runScope reads the partial-split marker its own builder emits", () => {
	it("reports the issue a `Part of #N` body names, and marks it non-closing", async () => {
		const out = await run(happy({body: "does things\n\nPart of #5434\nPart of #5437\n"}));
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`scoped\t${HEAD}\tpart-of:5434`);
	});

	it("carries the kind into --json, so the caller can tell a close from a split", async () => {
		const out = await run(happy({body: "Part of #5434"}), {json: true});
		expect(JSON.parse(out.stdout)).toMatchObject({issue: {kind: "part-of", number: 5434}});
	});

	it("still prefers the closing keyword when a body carries both markers", async () => {
		const out = await run(happy({body: "Fixes #4287\n\nPart of #4000"}));
		expect(out.stdout.split("\n")[0]).toBe(`scoped\t${HEAD}\tfixes:4287`);
	});
});

describe("runScope refusals and diagnostics", () => {
	// `binding()` puts `origin/main` ahead of the branch point, so the base on this line naming `BASE`
	// rather than `BASE_TIP` is what says the verb reports the merge base (#5770).
	it("reports the commit it bound to, then what it scanned against what was declared", async () => {
		const out = await run(happy());
		expect(out.stderr[0]).toBe(
			`review scope: bound to ${HEAD} (base ${BASE}) — read from the object database, nothing checked out.`,
		);
		expect(out.stderr[0]).not.toContain(BASE_TIP);
		expect(out.stderr[1]).toBe("review scope: scanned 2 changed files; 2 declared by GitHub.");
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe("review scope: PR #4321 not found in o/r.");
	});

	it("refuses a closed PR on 7 — nothing to review", async () => {
		const out = await run([[PULL, pull({state: "closed"})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review scope: PR #4321 is closed — nothing to review.");
	});

	it("refuses a zero-file PR on 7 rather than classifying an empty review (#4060)", async () => {
		const out = await run([[PULL, pull({changedFiles: 0})]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("has zero changed files");
	});

	it("separates an UNREADABLE PR from an absent one — 11, never 7", async () => {
		const out = await run([[PULL, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.code).not.toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("the scope is UNKNOWN");
	});

	it("refuses an unreadable file list on 11 — the partition would be over unknown scope", async () => {
		const out = await run([
			[PULL, pull()],
			[PATHS_AT(), errOut("fatal: bad revision")],
			...binding(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("the scope is UNKNOWN");
	});

	it("refuses an empty file list on 13, distinct from 11 and 7", async () => {
		const out = await run([[PULL, pull({changedFiles: 9})], ...binding(), [PATHS_AT(), paths()]]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.code).not.toBe(PRECONDITION_UNKNOWN);
		expect(out.code).not.toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`review scope: git reports no changed files for the range ${BASE}...${HEAD}, so ${HEAD} has nothing to partition — refusing to scope an empty read (#3999).`,
		);
	});

	it("refuses a non-PR number, and an unresolvable repo, on 1", async () => {
		expect((await run(happy(), {pr: 0})).code).toBe(1);
		const out = await Effect.runPromise(
			Effect.provide(runScope({...options, env: {}}), fakeShell([]).layer),
		);
		expect(out.code).toBe(1);
	});
});

/**
 * The single-source fence (#5154).
 *
 * The file list git returns for the bound range IS the scope; GitHub's `changed_files` has its own
 * merge base and its own rename detection, so it is reported and never refused on. Each case here
 * fails if the exit-`13` refusal drifts back onto that declared count.
 */
describe("runScope never refuses on GitHub's declared count", () => {
	/** git pairs the rename into one `--name-only` path; GitHub counts the delete and the add. */
	const renamed: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull({changedFiles: 2})],
		...binding(),
		[PATHS_AT(), paths("src/new.ts")],
	];

	it("scopes a rename git paired into one path, though GitHub declares two files", async () => {
		const out = await run(renamed);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain(`scoped\t${HEAD}\tfixes:4287`);
		expect(out.stdout).toContain("class\tcode\t1");
	});

	it("reports the git-vs-GitHub disagreement on stderr instead of refusing on it", async () => {
		const out = await run(renamed);
		expect(out.stderr).toContain(
			"review scope: git and GitHub disagree on #4321's file count (1 vs 2) — different merge base and different rename detection; reported, never refused on (#5154).",
		);
	});

	it("keeps GitHub's count visible in the scanned diagnostic", async () => {
		const out = await run(renamed);
		expect(out.stderr[1]).toBe("review scope: scanned 1 changed file; 2 declared by GitHub.");
	});

	it("scopes a list LONGER than GitHub declares, which the old inequality also let through", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			...binding(),
			[PATHS_AT(), paths("src/cart.ts", "README.md")],
		]);
		expect(out.code).toBe(0);
	});
});

/**
 * The provenance fence (#5117).
 *
 * The namespace set is documented as both floor and ceiling, so this list is not one input among
 * many — a list drawn from a later commit derives a namespace nobody judged, or drops one. Every
 * case here fails if the read reverts to the PR-number endpoint, which the fixture scripts with a
 * doc-only file set.
 */
describe("runScope binds its file list to the commit it prints", () => {
	it("partitions the bound commit's files, never the PR-number endpoint's", async () => {
		const {fake, out} = shell(happy());
		const result = await out;
		expect(result.stdout).toContain("class\tcode\t1");
		expect(result.stdout).not.toContain("class\tdoc\t2");
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ --name-only -z ${BASE}...${HEAD}`,
		);
		expect(fake.calls.some((c) => c.includes("pulls/4321/files"))).toBe(false);
	});

	it("prints the head it actually read the files out of", async () => {
		const {out} = shell(happy(), {sha: HEAD});
		const result = await out;
		expect(result.stdout.split("\n")[0]).toBe(`scoped\t${HEAD}\tfixes:4287`);
	});

	it("refuses on 12 when --sha is not the PR's head", async () => {
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

	it("refuses on 11 when the commit cannot be bound, rather than partitioning an unbound list", async () => {
		const out = await run([
			[PULL, pull()],
			[/^git remote -v$/, okOut("origin\tgit@github.com:someone/else.git (fetch)\n")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toBe(
			"review scope: no git remote in this checkout serves o/r — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.",
		);
	});
});
