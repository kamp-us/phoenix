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
import {runDeviations} from "./deviations-verb.ts";
import {BASE, binding, DIFF, DIFF_AT, HEAD, OLD_HEAD, pull} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;
/** The unbound endpoint this verb no longer reads — scripted so a regression has bytes to serve. */
const RAW = /^gh api -H Accept: application\/vnd\.github\.diff repos\/o\/r\/pulls\/4321$/;

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

const shell = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => {
	const fake = fakeShell(script);
	return {
		fake,
		out: Effect.runPromise(Effect.provide(runDeviations({...options, ...overrides}), fake.layer)),
	};
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) => shell(script, overrides).out;

/** The green path: the bound range serves `diff`, and the PR-number endpoint serves `endpoint`. */
const scripted = (
	diff: string,
	endpoint: string,
	shape: Parameters<typeof pull>[0] = {},
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull(shape)],
	...binding(),
	[DIFF_AT(), okOut(diff)],
	[RAW, okOut(endpoint)],
];

const happy = (shape: Parameters<typeof pull>[0] = {}) => scripted(DIFF, DIFF, shape);

describe("runDeviations", () => {
	it("prints none-declared for a `None.` body with a clean diff", async () => {
		const out = await run(happy());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("deviations\tnone-declared\n");
	});

	it("makes a falsified `None.` visible in one read — the claim beside the hits", async () => {
		const out = await run(scripted(SUPPRESSING_DIFF, SUPPRESSING_DIFF));
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
			"## Deviations\n\n- **Pre-existing test or fixture changed** — **Said:** replaced the two-decimal rendering assertion. **Did:** dropped it.";
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

	it("refuses a truncated diff on 13 — a partial scan must not print beside a claim", async () => {
		const out = await run(happy({changedFiles: 9}));
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("refusing a partial Tier-M scan beside a disclosure claim");
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe("review deviations: PR #4321 not found in o/r.");
	});

	it("refuses an unreadable body or diff on 11, and never answers `none`", async () => {
		for (const script of [
			[[PULL, errOut("gh: Bad gateway (HTTP 502)")]] as const,
			[[PULL, pull()], ...binding(), [DIFF_AT(), errOut("fatal: bad revision")]] as const,
		]) {
			const out = await run(script as ReadonlyArray<readonly [RegExp, ExecResult]>);
			expect(out.code).toBe(PRECONDITION_UNKNOWN);
			expect(out.stdout).toBe("");
			expect(out.stderr.at(-1)).toContain('the disclosure state is UNKNOWN, never "none"');
		}
	});
});

/**
 * The provenance fence (#5122), the sibling of `review scope`'s.
 *
 * A `deviation-disclosure` verdict claims "nothing undisclosed that this gate could see", so the hit
 * list is not one input among many — read at a head nobody scoped it is under- or over-reported
 * beside the disclosure it is printed next to, and the caller reads a checked-clean answer at exit 0.
 * Every case below scripts the PR-number endpoint with a *different* head's bytes, so a read that
 * reverts to it fails on a **wrong answer**, not on a crash.
 */
describe("runDeviations binds its Tier-M scan to a commit", () => {
	it("scans the bound commit's bytes, never the PR-number endpoint's", async () => {
		const {fake, out} = shell(scripted(SUPPRESSING_DIFF, DIFF));
		const result = await out;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("tier-m\tsuppression\tsrc/cart.ts:11\t@ts-expect-error");
		expect(fake.calls).toContain(
			`git diff --no-ext-diff --no-color --find-renames --src-prefix=a/ --dst-prefix=b/ ${BASE}...${HEAD}`,
		);
		expect(fake.calls.some((c) => c.includes("vnd.github.diff"))).toBe(false);
	});

	// The fail-OPEN direction, and the reason this is priced above its fail-closed sibling: the
	// unbound read answers `none-declared` with an empty hit list beside a `None.` body, at exit 0.
	it("does not print a clean scan beside a `None.` when the endpoint's head is the clean one", async () => {
		const out = await run(scripted(SUPPRESSING_DIFF, DIFF));
		expect(out.stdout).not.toBe("deviations\tnone-declared\n");
	});

	// The hole `12` cannot close: the head moved forward and was force-pushed back, so `--sha` IS the
	// live head and every staleness check passes — while the PR-number endpoint still serves the
	// intermediate head's bytes. Only reading at the commit tells the two trees apart.
	it("scans the recorded commit after a REWIND back onto it, not what the endpoint serves", async () => {
		const {fake, out} = shell(scripted(SUPPRESSING_DIFF, DIFF), {sha: HEAD});
		const result = await out;
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("tier-m\tremoved-assertion");
		expect(fake.calls.some((c) => c.includes("vnd.github.diff"))).toBe(false);
	});

	it("reports the commit it bound to, ahead of what it scanned", async () => {
		const out = await run(happy());
		expect(out.stderr[0]).toBe(
			`review deviations: bound to ${HEAD} (base ${BASE}) — read from the object database, nothing checked out.`,
		);
		expect(out.stderr[1]).toBe("review deviations: scanned 2 files; 2 declared.");
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
			[PULL, pull()],
			[/^git remote -v$/, okOut("origin\tgit@github.com:someone/else.git (fetch)\n")],
			[RAW, okOut(SUPPRESSING_DIFF)],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"review deviations: no git remote in this checkout serves o/r — the artifact cannot be bound to a commit, so what it shows is UNKNOWN.",
		);
	});
});
