import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runBase} from "./base-verb.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, STALE_HEAD, ZERO_SCOPE} from "./codes.ts";
import {
	binding,
	HEAD,
	BASE as MERGE_BASE,
	MERGE_BASE_OF,
	pull,
	RANGE_BASE,
	RANGE_MERGE_BASE,
	RANGE_TIP,
	SHOW_AT,
	SKILL_ROOT,
	TREE_AT,
	treeOf,
} from "./fixtures.test-support.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;

const options = {
	pr: 4321 as number | null,
	path: [] as ReadonlyArray<string>,
	base: null as string | null,
	tip: null as string | null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runBase({...options, ...overrides}), fakeShell(script).layer));

const SKILL_BYTES = "---\nname: governance\n---\n\n# governance\n";
const CONTRACT_BYTES = "# contract\n";

const upTo = (
	tree: ReadonlyArray<string> = [`${SKILL_ROOT}SKILL.md`, `${SKILL_ROOT}contract.md`],
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[once(PULL), pull()],
	...binding(),
	[PULL, pull()],
	[TREE_AT(MERGE_BASE), treeOf(...tree)],
];

const happy: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	...upTo(),
	[SHOW_AT(MERGE_BASE, `${SKILL_ROOT}SKILL.md`), okOut(SKILL_BYTES)],
	[SHOW_AT(MERGE_BASE, `${SKILL_ROOT}contract.md`), okOut(CONTRACT_BYTES)],
];

describe("runBase", () => {
	it("prints the merge base, then each file's header and its bytes back to back", async () => {
		const out = await run(happy);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			`base\t${MERGE_BASE}\t2\n` +
				`file\t${SKILL_ROOT}SKILL.md\t${SKILL_BYTES.length}\n${SKILL_BYTES}` +
				`file\t${SKILL_ROOT}contract.md\t${CONTRACT_BYTES.length}\n${CONTRACT_BYTES}`,
		);
	});

	it("names the merge base and the resolved root on stderr", async () => {
		const out = await run(happy);
		expect(out.stderr).toContain(
			`governance base: resolved this skill's own directory to ${SKILL_ROOT} at merge-base ${MERGE_BASE}.`,
		);
		expect(out.stderr.at(-1)).toBe(`governance base: merge base of #4321 is ${MERGE_BASE}.`);
	});

	it("refuses a --path outside the resolved root on 10 — this verb reads only its own text", async () => {
		const out = await run(happy, {path: ["claude-plugins/fabrika/skills/review/SKILL.md"]});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`governance base: --path "claude-plugins/fabrika/skills/review/SKILL.md" is outside this skill's own directory (${SKILL_ROOT}) — this verb reads only this skill's own text.`,
		);
	});

	it("refuses a merge base with NO install on 7 — there is no self fence to run", async () => {
		const out = await run(upTo(["src/cart.ts"]));
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toContain("this skill is not installed in the base revision");
	});

	it("refuses TWO installs on 11 rather than picking one, naming both", async () => {
		const out = await run(
			upTo(["a/fabrika/skills/governance/SKILL.md", "b/fabrika/skills/governance/SKILL.md"]),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(
			"a/fabrika/skills/governance/, b/fabrika/skills/governance/",
		);
		expect(out.stderr.at(-1)).toContain("refusing to guess");
	});

	it("refuses on 7 when the root resolves but no requested path exists at the base", async () => {
		const out = await run(upTo([`${SKILL_ROOT}SKILL.md`]), {
			path: [`${SKILL_ROOT}contract.md`],
		});
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(
			`governance base: none of the requested paths exist at merge-base ${MERGE_BASE} — there is no base revision to judge by.`,
		);
	});

	it("refuses on 11 when a path is THERE and will not read — never a fallback to the head", async () => {
		const out = await run([
			...upTo(),
			[SHOW_AT(MERGE_BASE, `${SKILL_ROOT}SKILL.md`), errOut("fatal: bad object")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses on 12 when the head moved while the base was being resolved", async () => {
		const moved = "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192";
		const out = await run([[once(PULL), pull()], ...binding(), [PULL, pull({head: moved})]]);
		expect(out.code).toBe(STALE_HEAD);
		expect(out.stderr.at(-1)).toBe(
			`governance base: #4321's head moved to ${moved} while resolving — re-run.`,
		);
	});

	// The resolve moved into the binding (#5770), so the failure arrives wearing this verb's own tail
	// rather than `bindHead`'s — the entry precedes `binding()` because the first match wins.
	it("refuses an unresolvable merge base on 11", async () => {
		const out = await run([
			[once(PULL), pull()],
			[/^git merge-base /, errOut("fatal: no merge base")],
			...binding(),
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain(
			"the merge base cannot be resolved, so the base rules are UNKNOWN.",
		);
	});

	it("refuses an absent PR on 7 and a non-PR number on 1", async () => {
		expect((await run([[PULL, errOut("gh: Not Found (HTTP 404)")]])).code).toBe(ZERO_SCOPE);
		expect((await run(happy, {pr: 0})).code).toBe(1);
	});

	it("reads the head it bound, so nothing is ever checked out", async () => {
		const fake = fakeShell(happy);
		await Effect.runPromise(Effect.provide(runBase(options), fake.layer));
		expect(fake.calls.some((call) => call.startsWith("git checkout"))).toBe(false);
		expect(fake.calls).toContain(`git ls-tree -r --name-only -z ${MERGE_BASE}`);
		expect(fake.calls).toContain(`git rev-parse --verify --quiet ${HEAD}^{commit}`);
	});
});

const ranged = {pr: null, base: RANGE_BASE, tip: RANGE_TIP};

const overRange = (
	tree: ReadonlyArray<string> = [`${SKILL_ROOT}SKILL.md`, `${SKILL_ROOT}contract.md`],
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[MERGE_BASE_OF(), okOut(`${RANGE_MERGE_BASE}\n`)],
	[TREE_AT(RANGE_MERGE_BASE), treeOf(...tree)],
];

const happyRange: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	...overRange(),
	[SHOW_AT(RANGE_MERGE_BASE, `${SKILL_ROOT}SKILL.md`), okOut(SKILL_BYTES)],
	[SHOW_AT(RANGE_MERGE_BASE, `${SKILL_ROOT}contract.md`), okOut(CONTRACT_BYTES)],
];

describe("runBase over a range", () => {
	it("serves the base revision's bytes at merge-base(base, tip)", async () => {
		const out = await run(happyRange, ranged);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			`base\t${RANGE_MERGE_BASE}\t2\n` +
				`file\t${SKILL_ROOT}SKILL.md\t${SKILL_BYTES.length}\n${SKILL_BYTES}` +
				`file\t${SKILL_ROOT}contract.md\t${CONTRACT_BYTES.length}\n${CONTRACT_BYTES}`,
		);
		expect(out.stderr.at(-1)).toBe(
			`governance base: merge base of ${RANGE_BASE}..${RANGE_TIP} is ${RANGE_MERGE_BASE}.`,
		);
	});

	it("keeps the --path fence on a range — this verb reads only its own text", async () => {
		const out = await run(happyRange, {
			...ranged,
			path: ["claude-plugins/fabrika/skills/review/SKILL.md"],
		});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("is outside this skill's own directory");
	});

	// The whole point of the range form: a fence that fell back to the tip would open exactly on the
	// child range that edits it (#6064).
	it("refuses an unresolvable merge base on 11, never falling back to the tip", async () => {
		const out = await run([[MERGE_BASE_OF(), errOut("fatal: no merge base")]], ranged);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`governance base: cannot resolve the merge base of ${RANGE_BASE}..${RANGE_TIP}: fatal: no merge base — the base rules are UNKNOWN; refusing to judge by the head's.`,
		);
	});

	it("refuses a base revision with NO install, and one where no requested path exists, on 7", async () => {
		expect((await run(overRange(["src/cart.ts"]), ranged)).code).toBe(ZERO_SCOPE);
		const missing = await run(overRange([`${SKILL_ROOT}SKILL.md`]), {
			...ranged,
			path: [`${SKILL_ROOT}contract.md`],
		});
		expect(missing.code).toBe(ZERO_SCOPE);
	});

	it("refuses TWO installs at the range's base on 11 rather than picking one", async () => {
		const out = await run(
			overRange(["a/fabrika/skills/governance/SKILL.md", "b/fabrika/skills/governance/SKILL.md"]),
			ranged,
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("refusing to guess");
	});

	it("refuses a lone end, a positional beside a range, and a subject named neither way, on 10", async () => {
		for (const overrides of [
			{pr: null, base: RANGE_BASE, tip: null},
			{pr: null, base: null, tip: RANGE_TIP},
		]) {
			const out = await run([], overrides);
			expect(out.code).toBe(OFF_VOCABULARY);
			expect(out.stderr.join("\n")).toContain("--base and --tip come together");
		}
		const withPr = await run([], {...ranged, pr: 4321});
		expect(withPr.code).toBe(OFF_VOCABULARY);
		expect(withPr.stderr.join("\n")).toContain("a range is its own subject");

		const none = await run([], {pr: null, base: null, tip: null});
		expect(none.code).toBe(OFF_VOCABULARY);
		expect(none.stderr.join("\n")).toContain("there is no subject here");
	});

	it("resolves no PR on a range — the epic child has none to resolve", async () => {
		const fake = fakeShell(happyRange);
		await Effect.runPromise(Effect.provide(runBase({...options, ...ranged}), fake.layer));
		expect(fake.calls.some((call) => call.startsWith("gh "))).toBe(false);
		expect(fake.calls.some((call) => call.startsWith("git checkout"))).toBe(false);
		expect(fake.calls).toContain(`git ls-tree -r --name-only -z ${RANGE_MERGE_BASE}`);
	});
});
