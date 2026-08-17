/**
 * The mutation harness: for each load-bearing guard, plant a counterexample the guard must catch,
 * then break exactly that guard and prove the verb answers **wrongly** instead.
 *
 * A guard you cannot demonstrate failing is not demonstrated. An ordinary unit test shows the guard
 * refusing; only the mutant shows that the refusal is *load-bearing* — that without it the verb
 * returns a plausible value over evidence it never had.
 *
 * **Every mutant is asserted to die for its INTENDED reason.** Each case pins the exact wrong answer
 * the mutant produces (a `green` rollup, a `current` binding, an exit 0 where a refusal belongs), not
 * merely that something differed. A sibling lane's harness scored every mutant "caught" while they
 * were all dying of an unrelated path-resolution error, so a loose `expect(mutant).not.toEqual(real)`
 * is exactly the assertion this file may not make.
 *
 * The mutants are injected by module substitution rather than by editing files on disk: each case
 * resets the module registry, overrides **one** export of **one** module over the real one, and
 * re-imports the verb. The specifiers below are byte-identical to the ones the verbs themselves
 * import, so no path is re-derived and nothing resolves through a symlink.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {afterEach, describe, expect, it, vi} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {APPEND_ONLY, INCOMPLETE_SCAN, LEAKED_PATH, READBACK_MISMATCH} from "./codes.ts";
import {
	binding,
	CONTENT,
	checkRuns,
	comments,
	DIFF,
	DIFF_AT,
	files,
	HEAD,
	issue,
	OLD_HEAD,
	PATHS_AT,
	paths,
	pull,
} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
const FILES = /^gh api --paginate repos\/o\/r\/pulls\/4321\/files/;
const RAW = /^gh api -H Accept: application\/vnd\.github\.diff repos\/o\/r\/pulls\/4321$/;
const RUNS = /^gh api --paginate repos\/o\/r\/commits\/[0-9a-f]+\/check-runs/;
const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4321\/comments/;
const CREATE = /^gh api --method POST repos\/o\/r\/issues\/4321\/comments /;
const READBACK = /^gh api repos\/o\/r\/issues\/comments\/\d+$/;
const USER = /^gh api user --jq \.login$/;
const PERMISSION = /^gh api repos\/o\/r\/collaborators\/kampus-bot\/permission --jq \.permission$/;
const ISSUE = /^gh api repos\/o\/r\/issues\/4287$/;
const PATCH = /^gh api --method PATCH repos\/o\/r\/issues\/4287 -f body=/;

const ENV = {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>;

/** The pinned write instant, and the stamp `review post` emits from it under every verdict body. */
const NOW = Effect.succeed(Date.parse("2026-08-09T06:30:00.412Z"));
const STAMP = "Verdict-written: 2026-08-09T06:30:00Z";

const withShell = <A>(
	effect: Effect.Effect<A, never, ChildProcessSpawner.ChildProcessSpawner>,
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, fakeShell(script).layer));

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("./rollup.ts");
	vi.doUnmock("./diff.ts");
	vi.doUnmock("../io/git.ts");
	vi.doUnmock("./append.ts");
	vi.doUnmock("../wire/verdict-marker.ts");
	vi.doUnmock("../report/leaks.ts");
	vi.doUnmock("../report/compose.ts");
});

/** Replace one export of one module, keeping every other export real. */
const mutate = async <M extends Record<string, unknown>>(
	specifier: string,
	patch: (actual: M) => Partial<M>,
): Promise<void> => {
	vi.resetModules();
	const actual = (await vi.importActual(specifier)) as M;
	vi.doMock(specifier, () => ({...actual, ...patch(actual)}));
};

describe("the CI rollup's fail-closed buckets", () => {
	const CANCELLED = checkRuns(1, [
		{name: "unit tests", status: "completed", conclusion: "cancelled"},
	]);
	const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull()],
		[RUNS, CANCELLED],
	];

	it("reds a cancelled check — a check that proved nothing must not read green", async () => {
		const {runCi} = await import("./ci-verb.ts");
		const out = await withShell(
			runCi({pr: 4321, sha: null, repo: null, json: false, env: ENV}),
			script,
		);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${HEAD}\tred`);
	});

	it("MUTANT: dropping `cancelled` from the red set makes the same PR report GREEN", async () => {
		await mutate<typeof import("./rollup.ts")>("./rollup.ts", (actual) => ({
			rollupOf: (runs) => actual.rollupOf(runs.filter((run) => run.conclusion !== "cancelled")),
		}));
		const {runCi} = await import("./ci-verb.ts");
		const out = await withShell(
			runCi({pr: 4321, sha: null, repo: null, json: false, env: ENV}),
			script,
		);
		// The intended death, named exactly: the answer flips to the permissive token, at exit 0.
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`ci\t${HEAD}\tgreen`);
	});
});

describe("the three-outcome binding", () => {
	const STALE = `review-code: PASS @ ${OLD_HEAD} — merge-ready`;
	const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull({comments: 1})],
		[COMMENTS, comments({id: 1, body: STALE})],
	];

	it("prints a stale PASS as stale", async () => {
		const {runVerdicts} = await import("./verdicts-verb.ts");
		const out = await withShell(runVerdicts({pr: 4321, repo: null, json: false, env: ENV}), script);
		expect(out.stdout).toContain("\tstale\t");
	});

	it("MUTANT: folding Stale into Current makes a stale PASS read as a CURRENT one (ADR 0058)", async () => {
		await mutate<typeof import("../wire/verdict-marker.ts")>(
			"../wire/verdict-marker.ts",
			(actual) => ({
				bindToContent: (claim, head, digest) => {
					const binding = actual.bindToContent(claim, head, digest);
					return binding._tag === "Stale"
						? ({_tag: "Current", sha: binding.markerSha, via: "head"} as const)
						: binding;
				},
			}),
		);
		const {runVerdicts} = await import("./verdicts-verb.ts");
		const out = await withShell(runVerdicts({pr: 4321, repo: null, json: false, env: ENV}), script);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("\tcurrent\t");
		expect(out.stdout).not.toContain("\tstale\t");
	});
});

describe("the diff completeness proof", () => {
	// The range carries seven files; the served diff carries two. Both counts are git's, over the
	// same range — anything but a refusal judges 2/7 (#5139).
	const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull({changedFiles: 7})],
		...binding(),
		[DIFF_AT(), okOut(DIFF)],
		[PATHS_AT(), paths("src/cart.ts", "README.md", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts")],
	];

	it("refuses a short diff on 13", async () => {
		const {runDiff} = await import("./diff-verb.ts");
		const out = await withShell(runDiff({pr: 4321, sha: null, repo: null, env: ENV}), script);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
	});

	it("MUTANT: a file count that always matches serves the partial diff as the whole (#3925)", async () => {
		await mutate<typeof import("./diff.ts")>("./diff.ts", () => ({filesInDiff: () => 7}));
		const {runDiff} = await import("./diff-verb.ts");
		const out = await withShell(runDiff({pr: 4321, sha: null, repo: null, env: ENV}), script);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(DIFF);
	});
});

/**
 * The provenance binding (#5117) — the guard whose absence is invisible from inside.
 *
 * A drifted read does not error and does not look short: the served artifact is well-formed, the
 * completeness proof passes, and the verdict carries a SHA. The mutants below restore exactly the
 * unbound read each verb used to make, and pin the plausible wrong answer that comes back — the
 * other head's bytes, and a namespace set derived from files the printed commit does not contain.
 */
describe("the commit binding on the read verbs", () => {
	/** What the PR-number endpoints serve once a push has landed: a different head's artifact. */
	const MOVED_DIFF = `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,1 +1,2 @@
 const x = 1;
+const y = 2;
`;

	const diffScript: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull({changedFiles: 1})],
		...binding(),
		[DIFF_AT(), okOut(DIFF)],
		[PATHS_AT(), paths("src/cart.ts")],
		[RAW, okOut(MOVED_DIFF)],
	];

	it("serves the bound commit's bytes", async () => {
		const {runDiff} = await import("./diff-verb.ts");
		const out = await withShell(runDiff({pr: 4321, sha: HEAD, repo: null, env: ENV}), diffScript);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(DIFF);
	});

	it("MUTANT: reading the PR-number diff endpoint serves another head's bytes under this SHA", async () => {
		await mutate<typeof import("../io/git.ts")>("../io/git.ts", () => ({
			diffRange: () => Effect.succeed({_tag: "Ok" as const, value: MOVED_DIFF}),
		}));
		const {runDiff} = await import("./diff-verb.ts");
		const out = await withShell(runDiff({pr: 4321, sha: HEAD, repo: null, env: ENV}), diffScript);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(MOVED_DIFF);
		expect(out.stdout).not.toBe(DIFF);
	});

	const scopeScript: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull({changedFiles: 1})],
		...binding(),
		[PATHS_AT(), paths("src/cart.ts")],
		[FILES, files("docs/moved.md")],
	];

	it("partitions the bound commit's file list", async () => {
		const {runScope} = await import("./scope-verb.ts");
		const out = await withShell(
			runScope({pr: 4321, sha: HEAD, repo: null, json: true, env: ENV}),
			scopeScript,
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({head: HEAD, namespaces: ["review-code"]});
	});

	it("MUTANT: reading the PR-number file list derives a namespace the printed head never had", async () => {
		await mutate<typeof import("../io/git.ts")>("../io/git.ts", () => ({
			diffRangePaths: () => Effect.succeed({_tag: "Ok" as const, value: ["docs/moved.md"]}),
		}));
		const {runScope} = await import("./scope-verb.ts");
		const out = await withShell(
			runScope({pr: 4321, sha: HEAD, repo: null, json: true, env: ENV}),
			scopeScript,
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({head: HEAD, namespaces: ["review-doc"]});
	});

	// #5122's half: the same unbound read, at the two seams #5117 left behind. Both mutants die
	// fail-OPEN — a checked-clean disclosure and a posted verdict, each at exit 0.
	const SUPPRESSING_DIFF = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -10,1 +10,2 @@
 const items = read();
+// @ts-expect-error the types are wrong
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # phoenix
+a line
`;

	const deviationsScript: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull()],
		...binding(),
		[DIFF_AT(), okOut(SUPPRESSING_DIFF)],
		[PATHS_AT(), paths("src/cart.ts", "README.md")],
		[RAW, okOut(DIFF)],
	];

	it("scans the bound commit's bytes for Tier-M tokens", async () => {
		const {runDeviations} = await import("./deviations-verb.ts");
		const out = await withShell(
			runDeviations({pr: 4321, sha: HEAD, repo: null, json: false, env: ENV}),
			deviationsScript,
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("tier-m\tsuppression");
	});

	it("MUTANT: reading the PR-number diff prints a clean scan beside a `None.` that is false", async () => {
		await mutate<typeof import("../io/git.ts")>("../io/git.ts", () => ({
			diffRange: () => Effect.succeed({_tag: "Ok" as const, value: DIFF}),
		}));
		const {runDeviations} = await import("./deviations-verb.ts");
		const out = await withShell(
			runDeviations({pr: 4321, sha: HEAD, repo: null, json: false, env: ENV}),
			deviationsScript,
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("deviations\tnone-declared\n");
	});

	const postOptions = {
		pr: 4321,
		namespace: "review-skill",
		polarity: "PASS",
		sha: HEAD,
		clause: "guide matches shipped behavior",
		carrier: "marker",
		repo: null,
		json: false,
		env: ENV,
		stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "the table\n"}),
		now: NOW,
	};
	const postScript: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull({changedFiles: 1})],
		...binding(),
		[PATHS_AT(), paths("src/cart.ts")],
		[FILES, files("skills/deploy/SKILL.md")],
		[USER, okOut("kampus-bot")],
		[COMMENTS, comments()],
		[CREATE, okOut(JSON.stringify({id: 1, html_url: "https://example.test/c/1"}))],
		[
			READBACK,
			okOut(
				JSON.stringify({
					body: `review-skill: PASS @ ${HEAD} content:${CONTENT} — guide matches shipped behavior\n\nthe table\n\n${STAMP}`,
				}),
			),
		],
	];

	it("refuses a namespace the bound commit's file list does not derive", async () => {
		const {runPost} = await import("./post-verb.ts");
		const shell = fakeShell(postScript);
		const out = await Effect.runPromise(Effect.provide(runPost(postOptions), shell.layer));
		expect(out.code).toBe(10);
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("MUTANT: reading the PR-number file list POSTS a namespace this run never derived", async () => {
		await mutate<typeof import("../io/git.ts")>("../io/git.ts", () => ({
			diffRangePaths: () =>
				Effect.succeed({_tag: "Ok" as const, value: ["skills/deploy/SKILL.md"]}),
		}));
		const {runPost} = await import("./post-verb.ts");
		const shell = fakeShell(postScript);
		const out = await Effect.runPromise(Effect.provide(runPost(postOptions), shell.layer));
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("posted\treview-skill\tPASS");
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(true);
	});
});

describe("the leak predicate over the assembled verdict", () => {
	const LEAKY = "the failure is at /Users/someone/scratch/case.md";
	const options = {
		pr: 4321,
		namespace: "review-doc",
		polarity: "PASS",
		sha: HEAD,
		clause: "guide matches shipped behavior",
		carrier: "marker",
		repo: null,
		json: false,
		env: ENV,
		stdin: Effect.succeed<StdinRead>({_tag: "Text", text: LEAKY}),
		now: NOW,
	};
	const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull()],
		...binding(),
		[PATHS_AT(), paths("src/cart.ts", "README.md")],
		[FILES, files("skills/deploy/SKILL.md")],
		[USER, okOut("kampus-bot")],
		[COMMENTS, comments()],
		[CREATE, okOut(JSON.stringify({id: 1, html_url: "https://example.test/c/1"}))],
		[
			READBACK,
			okOut(
				JSON.stringify({
					body: `review-doc: PASS @ ${HEAD} content:${CONTENT} — guide matches shipped behavior\n\n${LEAKY}\n\n${STAMP}`,
				}),
			),
		],
	];

	it("refuses a machine-local path in the verdict body on 5, posting nothing", async () => {
		const {runPost} = await import("./post-verb.ts");
		const shell = fakeShell(script);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(LEAKED_PATH);
		expect(shell.calls.some((call) => CREATE.test(call))).toBe(false);
	});

	it("MUTANT: a predicate that finds nothing posts the machine-local path to the PR (#3173)", async () => {
		await mutate<typeof import("../report/leaks.ts")>("../report/leaks.ts", () => ({
			scanBody: (body: string) => ({leaks: [], redacted: body}),
		}));
		const {runPost} = await import("./post-verb.ts");
		const shell = fakeShell(script);
		const out = await Effect.runPromise(Effect.provide(runPost(options), shell.layer));
		expect(out.code).toBe(0);
		expect(shell.calls.some((call) => call.includes("/Users/someone/scratch/case.md"))).toBe(true);
	});
});

describe("normalizeForReadback's trailing-newline step", () => {
	// The contract's explicit warning: a re-derivation that drops the third step fires exit 9 on a
	// clean run. The counterexample is a comment GitHub echoed back with a trailing newline.
	const options = {
		pr: 4321,
		namespace: "review-doc",
		polarity: "PASS",
		sha: HEAD,
		clause: "guide matches shipped behavior",
		carrier: "marker",
		repo: null,
		json: false,
		env: ENV,
		stdin: Effect.succeed<StdinRead>({_tag: "Text", text: "the table\n"}),
		now: NOW,
	};
	const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull()],
		...binding(),
		[PATHS_AT(), paths("src/cart.ts", "README.md")],
		[FILES, files("skills/deploy/SKILL.md")],
		[USER, okOut("kampus-bot")],
		[COMMENTS, comments()],
		[CREATE, okOut(JSON.stringify({id: 1, html_url: "https://example.test/c/1"}))],
		[
			READBACK,
			okOut(
				JSON.stringify({
					body: `review-doc: PASS @ ${HEAD} content:${CONTENT} — guide matches shipped behavior   \n\nthe table\n\n${STAMP}\n\n\n`,
				}),
			),
		],
	];

	it("accepts a read-back that differs only in trailing whitespace", async () => {
		const {runPost} = await import("./post-verb.ts");
		const out = await withShell(runPost(options), script);
		expect(out.code).toBe(0);
	});

	it("MUTANT: dropping the trailing-newline step fires exit 9 on a CLEAN run", async () => {
		await mutate<typeof import("../report/compose.ts")>("../report/compose.ts", () => ({
			normalizeForReadback: (text: string) => text,
		}));
		const {runPost} = await import("./post-verb.ts");
		const out = await withShell(runPost(options), script);
		expect(out.code).toBe(READBACK_MISMATCH);
		expect(out.stderr.at(-1)).toContain("the comment's bytes are not the ones that were sent");
	});
});

describe("the append-only fence", () => {
	const TEXT = "a regression test covers qty > 1";
	const options = {
		issue: 4287,
		pr: 4321,
		round: 1,
		repo: null,
		json: false,
		env: ENV,
		stdin: Effect.succeed<StdinRead>({_tag: "Text", text: TEXT}),
	};
	const WITH_LATER_SECTION = `### Acceptance criteria

- [ ] the only criterion

## Notes

nothing yet.
`;
	const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[USER, okOut("kampus-bot")],
		[PERMISSION, okOut("write")],
		[ISSUE, issue(WITH_LATER_SECTION)],
		[PATCH, okOut("{}")],
	];

	it("MUTANT: a composition that appends PAST the block reds on 15, before any PATCH", async () => {
		await mutate<typeof import("./append.ts")>("./append.ts", () => ({
			insertAfterLastCriterion: (body: string, row: string) => ({
				_tag: "Composed" as const,
				body: `${body}\n${row}`,
			}),
		}));
		const {runAppendCriterion} = await import("./append-criterion-verb.ts");
		const shell = fakeShell(script);
		const out = await Effect.runPromise(Effect.provide(runAppendCriterion(options), shell.layer));
		expect(out.code).toBe(APPEND_ONLY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review append-criterion: the composed body does not re-read as the 1 prior row(s) plus this one — it re-reads as 1 row(s); refusing (append-only fence).",
		);
		expect(shell.calls.some((call) => PATCH.test(call))).toBe(false);
	});

	it("MUTANT: a growth check that always passes lets an unchanged read-back exit 0", async () => {
		await mutate<typeof import("./append.ts")>("./append.ts", () => ({
			grewByOne: () => true,
		}));
		const {runAppendCriterion} = await import("./append-criterion-verb.ts");
		const unchanged: ReadonlyArray<readonly [RegExp, ExecResult]> = [
			[USER, okOut("kampus-bot")],
			[PERMISSION, okOut("write")],
			[once(ISSUE), issue()],
			[ISSUE, issue()],
			[PATCH, okOut("{}")],
		];
		const out = await withShell(runAppendCriterion(options), unchanged);
		expect(out.code).toBe(0);
	});

	it("without the mutant, that same unchanged read-back reds on 9", async () => {
		const {runAppendCriterion} = await import("./append-criterion-verb.ts");
		const unchanged: ReadonlyArray<readonly [RegExp, ExecResult]> = [
			[USER, okOut("kampus-bot")],
			[PERMISSION, okOut("write")],
			[once(ISSUE), issue()],
			[ISSUE, issue()],
			[PATCH, okOut("{}")],
		];
		const out = await withShell(runAppendCriterion(options), unchanged);
		expect(out.code).toBe(READBACK_MISMATCH);
	});
});

describe("the empty-read refusal on the changed-file list", () => {
	// git reports no paths while GitHub declares nine: the emptiness refuses, the disagreement does
	// not (#5154).
	const script: ReadonlyArray<readonly [RegExp, ExecResult]> = [
		[PULL, pull({changedFiles: 9})],
		...binding(),
		[PATHS_AT(), paths()],
	];

	it("refuses a partition over an empty read on 13", async () => {
		const {runScope} = await import("./scope-verb.ts");
		const out = await withShell(
			runScope({pr: 4321, sha: null, repo: null, json: false, env: ENV}),
			script,
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
	});

	it("MUTANT: a file list padded past empty partitions phantom files as the whole", async () => {
		await mutate<typeof import("../io/git.ts")>("../io/git.ts", (actual) => ({
			diffRangePaths: (base: string, head: string) =>
				Effect.map(actual.diffRangePaths(base, head), (attempt) =>
					attempt._tag === "Ok" && attempt.value.length === 0
						? {_tag: "Ok" as const, value: ["pad-0.ts"]}
						: attempt,
				),
		}));
		const {runScope} = await import("./scope-verb.ts");
		const out = await withShell(
			runScope({pr: 4321, sha: null, repo: null, json: false, env: ENV}),
			script,
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("scoped\t");
	});

	it("proves the harness itself is live — an unscripted call still fails loudly", async () => {
		const {runScope} = await import("./scope-verb.ts");
		const out = await withShell(
			runScope({pr: 4321, sha: null, repo: null, json: false, env: ENV}),
			[[PULL, errOut("gh: Bad gateway (HTTP 502)")]],
		);
		expect(out.code).not.toBe(0);
	});
});
