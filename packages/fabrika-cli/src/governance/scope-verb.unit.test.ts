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
	FULL_TREE,
	HEAD,
	MERGE_BASE_OF,
	OLD_HEAD,
	PATHS_AT,
	paths,
	pull,
	RANGE_BASE,
	RANGE_MERGE_BASE,
	RANGE_TIP,
	SKILL_ROOT,
	STATUS_AT,
	statuses,
	TREE_AT,
	treeOf,
} from "./fixtures.test-support.ts";
import {NOT_CP_NOTICE, runScope} from "./scope-verb.ts";

const PULL = /^gh api repos\/o\/r\/pulls\/4321$/;

const options = {
	pr: 4321 as number | null,
	sha: null as string | null,
	base: null as string | null,
	tip: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runScope({...options, ...overrides}), fakeShell(script).layer));

const happy = (
	...rows: ReadonlyArray<readonly [string, string]>
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[PULL, pull({changedFiles: rows.length})],
	...binding(),
	[STATUS_AT(), statuses(...rows)],
	[TREE_AT(), treeOf(...FULL_TREE)],
];

const GOVERNING = happy(
	["A", ".decisions/0240-only-landed-adrs-may-be-cited.md"],
	["M", "claude-plugins/fabrika/skills/review/SKILL.md"],
);

describe("runScope", () => {
	it("prints the outcome, the head, each touched root, `self`, and each record", async () => {
		const out = await run(GOVERNING);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`governance\trequired\t${HEAD}`,
				"root\t.decisions/\t1",
				"root\tclaude-plugins/\t1",
				"self\tfalse",
				"record\t0240\tadded\t.decisions/0240-only-landed-adrs-may-be-cited.md",
				"",
			].join("\n"),
		);
	});

	it("answers `not-required` for a diff under no root — a computed answer, not a silence", async () => {
		const out = await run(happy(["M", "src/cart.ts"]));
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`governance\tnot-required\t${HEAD}`);
	});

	it("sets `self` on this skill's own diff, which derives its own namespace by construction", async () => {
		const out = await run(happy(["M", "claude-plugins/fabrika/skills/governance/SKILL.md"]));
		expect(out.stdout).toContain("self\ttrue");
	});

	// The binding runs against a main that has moved on (`BASE_TIP` is ahead of `BASE`), so `base`
	// naming the branch point rather than that tip is the whole assertion here (#5770).
	it("emits the record with --json, carrying the merge base the range was read across", async () => {
		const out = await run(GOVERNING, {json: true});
		const record = JSON.parse(out.stdout);
		expect(record).toMatchObject({
			outcome: "required",
			head: HEAD,
			base: BASE,
			self: false,
			scanned: 2,
			records: [{id: "0240", change: "added"}],
		});
		expect(record.base).not.toBe(BASE_TIP);
	});

	it("says on stderr, on every run, that this is not the §CP answer", async () => {
		expect((await run(GOVERNING)).stderr).toContain(NOT_CP_NOTICE);
		expect((await run([[PULL, errOut("gh: Not Found (HTTP 404)")]])).stderr).toContain(
			NOT_CP_NOTICE,
		);
	});

	it("reports the commit it bound to and what it partitioned", async () => {
		const out = await run(GOVERNING);
		expect(out.stderr[0]).toBe(
			`governance scope: bound to ${HEAD} (base ${BASE}) — read from the object database, nothing checked out.`,
		);
		expect(out.stderr).toContain(
			`governance scope: partitioned 2 of the 2 declared changed files at ${HEAD} across 4 roots.`,
		);
	});

	it("names a root that is absent in this repository rather than counting it silently", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 1})],
			...binding(),
			[STATUS_AT(), statuses(["M", ".decisions/0240-x.md"])],
			[TREE_AT(), treeOf(".decisions/0240-x.md", "src/cart.ts")],
		]);
		expect(out.stderr).toContain(
			"governance scope: root .claude/ is absent in this repository — the derivation covered 1 of 4 roots.",
		);
	});

	it("refuses a PR proven absent on 7", async () => {
		const out = await run([[PULL, errOut("gh: Not Found (HTTP 404)")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
	});

	it("refuses a closed PR, and a zero-file PR, on 7 — never `not-required`", async () => {
		expect((await run([[PULL, pull({state: "closed"})]])).code).toBe(ZERO_SCOPE);
		const empty = await run([[PULL, pull({changedFiles: 0})]]);
		expect(empty.code).toBe(ZERO_SCOPE);
		expect(empty.stderr.at(-2)).toContain("refusing to derive over an empty diff");
	});

	it("separates an UNREADABLE PR from an absent one — 11, never 7", async () => {
		const out = await run([[PULL, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.code).not.toBe(ZERO_SCOPE);
		expect(out.stderr.at(-2)).toContain('is UNKNOWN, never "not-required"');
	});

	it("phrases the binding failure in this verb's own noun", async () => {
		const out = await run([
			[PULL, pull()],
			[/^git remote -v$/, okOut("origin\tgit@github.com:someone/else.git (fetch)\n")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-2)).toBe(
			"governance scope: no git remote in this checkout serves o/r — the file list cannot be bound to a commit, so the derivation is UNKNOWN.",
		);
	});

	it("refuses a short changed-file read on 13, distinct from 11 and 7", async () => {
		const out = await run([
			[PULL, pull({changedFiles: 9})],
			...binding(),
			[STATUS_AT(), statuses(["M", "src/cart.ts"])],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.code).not.toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-2)).toBe(
			`governance scope: ${HEAD} carries 1 of the 9 files #4321 declares — refusing to derive from a short read (#3999).`,
		);
	});

	it("refuses a --sha that is not the PR's head on 12, and a malformed one on 10", async () => {
		expect((await run(GOVERNING, {sha: OLD_HEAD})).code).toBe(STALE_HEAD);
		expect((await run(GOVERNING, {sha: "origin/main"})).code).toBe(OFF_VOCABULARY);
	});

	it("refuses a non-PR number, and an unresolvable repo, on 1", async () => {
		expect((await run(GOVERNING, {pr: 0})).code).toBe(1);
		expect((await run(GOVERNING, {env: {}})).code).toBe(1);
	});
});

const ranged = {pr: null, base: RANGE_BASE, tip: RANGE_TIP};

const overRange = (
	...rows: ReadonlyArray<readonly [string, string]>
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[MERGE_BASE_OF(), okOut(`${RANGE_MERGE_BASE}\n`)],
	[STATUS_AT(RANGE_BASE, RANGE_TIP), statuses(...rows)],
	[PATHS_AT(RANGE_BASE, RANGE_TIP), paths(...rows.map(([, path]) => path))],
	[TREE_AT(RANGE_TIP), treeOf(...FULL_TREE)],
];

describe("runScope over a range", () => {
	it("derives the same shape a PR does, naming the range where a head would go", async () => {
		const out = await run(
			overRange(
				["A", ".decisions/0240-only-landed-adrs-may-be-cited.md"],
				["M", "claude-plugins/fabrika/skills/review/SKILL.md"],
			),
			ranged,
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				`governance\trequired\t${RANGE_BASE}..${RANGE_TIP}`,
				"root\t.decisions/\t1",
				"root\tclaude-plugins/\t1",
				"self\tfalse",
				"record\t0240\tadded\t.decisions/0240-only-landed-adrs-may-be-cited.md",
				"",
			].join("\n"),
		);
	});

	it("answers `not-required` for a range under no root", async () => {
		const out = await run(overRange(["M", "src/cart.ts"]), ranged);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`governance\tnot-required\t${RANGE_BASE}..${RANGE_TIP}`);
	});

	// The self fence's own precondition: a child range editing this skill has to READ as self-editing
	// before `governance base` can be asked for the base revision's bytes (#6064).
	it("sets `self` on a range that edits this skill, and names merge-base(base, tip) as the base", async () => {
		const out = await run(overRange(["M", `${SKILL_ROOT}SKILL.md`]), {...ranged, json: true});
		const record = JSON.parse(out.stdout);
		expect(record).toMatchObject({
			outcome: "required",
			self: true,
			head: `${RANGE_BASE}..${RANGE_TIP}`,
			base: RANGE_MERGE_BASE,
			scanned: 1,
		});
	});

	it("reports the commit it bound to, and the merge base beside it", async () => {
		const out = await run(overRange(["M", "src/cart.ts"]), ranged);
		expect(out.stderr[0]).toBe(
			`governance scope: bound to ${RANGE_TIP} (base ${RANGE_MERGE_BASE}) — read from the object database, nothing checked out.`,
		);
		expect(out.stderr).toContain(NOT_CP_NOTICE);
	});

	it("refuses an empty range on 7, never `not-required` (ADR 0092)", async () => {
		const out = await run(
			[
				[MERGE_BASE_OF(), okOut(`${RANGE_MERGE_BASE}\n`)],
				[STATUS_AT(RANGE_BASE, RANGE_TIP), statuses()],
				[PATHS_AT(RANGE_BASE, RANGE_TIP), paths()],
			],
			ranged,
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-2)).toContain("refusing to derive over an empty diff");
	});

	it("refuses a short changed-file read on 13, distinct from 11 and 7", async () => {
		const out = await run(
			[
				[MERGE_BASE_OF(), okOut(`${RANGE_MERGE_BASE}\n`)],
				[STATUS_AT(RANGE_BASE, RANGE_TIP), statuses(["M", "src/cart.ts"])],
				[PATHS_AT(RANGE_BASE, RANGE_TIP), paths("src/cart.ts", ".decisions/0240-x.md")],
			],
			ranged,
		);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-2)).toBe(
			`governance scope: ${RANGE_BASE}..${RANGE_TIP} carries 1 of the 2 files its ends change — refusing to derive from a short read (#3999).`,
		);
	});

	it("refuses an unreadable range on 11 — UNKNOWN, never `not-required`", async () => {
		const unresolvable = await run(
			[[MERGE_BASE_OF(), errOut("fatal: Not a valid object name")]],
			ranged,
		);
		expect(unresolvable.code).toBe(PRECONDITION_UNKNOWN);
		expect(unresolvable.stderr.at(-2)).toContain(
			`cannot resolve the merge base of ${RANGE_BASE}..${RANGE_TIP}`,
		);

		const undiffable = await run(
			[
				[MERGE_BASE_OF(), okOut(`${RANGE_MERGE_BASE}\n`)],
				[STATUS_AT(RANGE_BASE, RANGE_TIP), errOut("fatal: bad object")],
			],
			ranged,
		);
		expect(undiffable.code).toBe(PRECONDITION_UNKNOWN);
		expect(undiffable.stdout).toBe("");
	});

	it("refuses a lone end, a --sha beside a range, and a positional beside one, on 10", async () => {
		for (const overrides of [
			{pr: null, base: RANGE_BASE, tip: null},
			{pr: null, base: null, tip: RANGE_TIP},
		]) {
			const out = await run([], overrides);
			expect(out.code).toBe(OFF_VOCABULARY);
			expect(out.stderr.join("\n")).toContain("--base and --tip come together");
		}
		const withSha = await run([], {...ranged, sha: HEAD});
		expect(withSha.code).toBe(OFF_VOCABULARY);
		expect(withSha.stderr.join("\n")).toContain("--sha does not combine with --base/--tip");

		const withPr = await run([], {...ranged, pr: 4321});
		expect(withPr.code).toBe(OFF_VOCABULARY);
		expect(withPr.stderr.join("\n")).toContain("a range is its own subject");
	});

	it("refuses a range end that is not a revision, and a subject named neither way, on 10", async () => {
		const bad = await run([], {...ranged, tip: "origin/main"});
		expect(bad.code).toBe(OFF_VOCABULARY);
		expect(bad.stderr.join("\n")).toContain('--tip "origin/main" is not a revision');

		const none = await run([], {pr: null, base: null, tip: null});
		expect(none.code).toBe(OFF_VOCABULARY);
		expect(none.stderr.join("\n")).toContain("there is no subject here");
	});

	it("reads only the object database — no PR is resolved and nothing is checked out", async () => {
		const fake = fakeShell(overRange(["M", "src/cart.ts"]));
		await Effect.runPromise(Effect.provide(runScope({...options, ...ranged}), fake.layer));
		expect(fake.calls.some((call) => call.startsWith("gh "))).toBe(false);
		expect(fake.calls.some((call) => call.startsWith("git checkout"))).toBe(false);
		expect(fake.calls).toContain(`git merge-base ${RANGE_BASE} ${RANGE_TIP}`);
	});
});
