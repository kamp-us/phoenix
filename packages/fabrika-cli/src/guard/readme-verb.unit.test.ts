/**
 * `guard readme-guard check`, ported from v1's `readme-guard` — the scope
 * filter, the fail-closed floor and the exit taxonomy, over a scripted filesystem.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import type {TreeScope} from "./local-tree.ts";
import {runReadmeGuard} from "./readme-verb.ts";

const ROOT = "/repo";
const WORKSPACE = `${ROOT}/pnpm-workspace.yaml`;

const workspace = (globs: ReadonlyArray<string> = ["packages/*", "apps/*"]) =>
	`packages:\n${globs.map((g) => `  - ${g}`).join("\n")}\n`;

const WHOLE_TREE: TreeScope = {_tag: "WholeTree"};

/** The scope `build check` hands the guard: the paths its diff adds, edits or deletes. */
const change = (...paths: ReadonlyArray<string>): TreeScope => ({_tag: "Change", paths});

const run = (
	options: FakeFsOptions,
	env: Record<string, string | undefined> = {},
	scope: TreeScope = WHOLE_TREE,
) =>
	Effect.runPromise(
		Effect.provide(runReadmeGuard({root: ROOT, cwd: ROOT, env, scope}), fakeFs(options).layer),
	);

/** A repo whose `packages/` holds the named members, each with the files listed for it. */
const repo = (
	members: Readonly<Record<string, ReadonlyArray<string>>>,
	globs?: ReadonlyArray<string>,
): FakeFsOptions => {
	const files: Record<string, string> = {[WORKSPACE]: workspace(globs)};
	const directories = [`${ROOT}/packages`];
	for (const [name, held] of Object.entries(members)) {
		directories.push(`${ROOT}/packages/${name}`);
		for (const file of held) files[`${ROOT}/packages/${name}/${file}`] = "x";
	}
	return {files, dirs: {[`${ROOT}/packages`]: Object.keys(members)}, directories};
};

describe("runReadmeGuard", () => {
	it("passes when every real member carries a README", async () => {
		const outcome = await run(
			repo({a: ["package.json", "README.md"], b: ["package.json", "README.md"]}),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("all 2 packages/* workspace members carry a README.md");
		expect(outcome.stderr).toEqual([]);
	});

	it("ignores dead-shell directories rather than redding on them", async () => {
		const outcome = await run(repo({real: ["package.json", "README.md"], "dead-shell": []}));
		expect(outcome.code).toBe(0);
	});

	it("reds on a member with no README, naming it and nothing else", async () => {
		const outcome = await run(
			repo({good: ["package.json", "README.md"], bad: ["package.json"], shell: []}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("packages/bad");
		expect(outcome.stderr.join("\n")).not.toContain("packages/good");
		expect(outcome.stderr.join("\n")).toContain("1 packages/* workspace member lacks");
	});

	// The annotation hangs on the manifest, not on the absent README: GitHub needs a file that
	// exists to render against, and the manifest is what proves the directory is a member.
	it("annotates each offender on its package.json under Actions", async () => {
		const outcome = await run(repo({bad: ["package.json"]}), {GITHUB_ACTIONS: "true"});
		expect(outcome.stderr).toContain(
			"::error file=packages/bad/package.json::packages/bad has no README.md — every packages/* workspace package must carry one (what it is, why it exists, how to use it). Fix: add packages/bad/README.md.",
		);
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run(repo({bad: ["package.json"]}));
		expect(outcome.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	// The fail-closed floor: a scan that found nothing has proven nothing, so it reds.
	it("fails closed when the scan finds zero members", async () => {
		const outcome = await run(repo({"dead-a": [], "dead-b": ["README.md"]}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO");
	});

	it("fails closed when the workspace no longer declares packages/*", async () => {
		const outcome = await run(repo({a: ["package.json", "README.md"]}, ["apps/*"]));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("does not declare");
	});

	// UNKNOWN and not clean, and on its own seat: "I could not read the tree" and "your change broke
	// the rule" have opposite remedies.
	it("answers UNKNOWN when a read fails, never clean", async () => {
		const options = repo({a: ["package.json", "README.md"]});
		const outcome = await run({...options, unreadable: [WORKSPACE]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when no repo root sits above the cwd", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runReadmeGuard({root: null, cwd: "/nowhere", env: {}, scope: WHOLE_TREE}),
				fakeFs({files: {}}).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("no repo root");
	});
});

// A consumer repo whose older packages predate the rule: `build check` judges only the
// members its diff touches, while the CLI leaf CI runs still judges the whole tree.
describe("runReadmeGuard under a change scope", () => {
	const legacy = repo({
		documented: ["package.json", "README.md"],
		"old-a": ["package.json", "index.ts"],
		"old-b": ["package.json"],
	});

	it("does not red when the change touches none of the README-less members", async () => {
		const outcome = await run(legacy, {}, change("packages/documented/src/x.ts", "apps/site/y.ts"));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("touches 1 of 3 packages/* workspace members");
		expect(outcome.stderr).toEqual([]);
	});

	it("does not red when the change touches no member at all", async () => {
		const outcome = await run(legacy, {}, change("README.md"));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("touches 0 of 3");
	});

	it("still reds the same tree under the whole-tree scope the CI leaf runs", async () => {
		const outcome = await run(legacy);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("packages/old-a");
		expect(outcome.stderr.join("\n")).toContain("packages/old-b");
	});

	it("reds on a new member the change adds without a README", async () => {
		const withNew = repo({documented: ["package.json", "README.md"], fresh: ["package.json"]});
		const outcome = await run(withNew, {}, change("packages/fresh/package.json"));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("packages/fresh");
	});

	it("reds on an edit inside a README-less member, naming that member and no other", async () => {
		const outcome = await run(legacy, {}, change("packages/old-a/index.ts"));
		expect(outcome.code).toBe(VIOLATION);
		const report = outcome.stderr.join("\n");
		expect(report).toContain("packages/old-a");
		expect(report).not.toContain("packages/old-b");
		expect(report).toContain("1 packages/* workspace member lacks");
	});

	it("does not read a sibling whose name only shares a prefix as touched", async () => {
		const outcome = await run(legacy, {}, change("packages/old-ab/index.ts"));
		expect(outcome.code).toBe(0);
	});

	// The floors still read the whole tree: a narrowed scope never turns a broken workspace into a pass.
	it("keeps the zero-scope refusal on 7", async () => {
		const outcome = await run(repo({"dead-a": []}), {}, change("packages/dead-a/x.ts"));
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("keeps the undeclared-glob refusal on 7", async () => {
		const outcome = await run(
			repo({a: ["package.json"]}, ["apps/*"]),
			{},
			change("packages/a/package.json"),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("keeps the unreadable refusal on 11", async () => {
		const outcome = await run(
			{...legacy, unreadable: [WORKSPACE]},
			{},
			change("packages/old-a/index.ts"),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
