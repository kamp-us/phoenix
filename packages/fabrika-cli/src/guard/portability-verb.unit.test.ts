/**
 * `guard portability-guard check` — the two-root scope walk, its fail-closed floors and the exit
 * taxonomy, over a scripted filesystem.
 *
 * Each floor is asserted rather than trusted, because each one is a way this guard could go green
 * having judged nothing: a root that resolves elsewhere, an empty walk, a directory the walk never
 * entered, and an allow-list nobody could parse.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	type FakeFsOptions,
	type FakeShell,
	fakeFs,
	fakeShell,
	okOut,
} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {CONFIG_PATH, runPortabilityCheck, runPortabilityGuard} from "./portability-verb.ts";

const ROOT = "/repo";
const PLUGIN = `${ROOT}/claude-plugins/fabrika`;
const SOURCE = `${ROOT}/packages/fabrika-cli/src`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runPortabilityGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

interface Tree {
	/** Skill name → file name → contents, under the plugin's `skills/` directory. */
	readonly skills?: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** Verb group → file name → contents, under the package's `src/`. */
	readonly groups?: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly allowList?: string;
	readonly repoNames?: ReadonlyArray<string>;
}

const scriptTree = ({skills = {}, groups = {}, allowList, repoNames}: Tree): FakeFsOptions => {
	const dirs: Record<string, ReadonlyArray<string>> = {
		[PLUGIN]: ["skills"],
		[`${PLUGIN}/skills`]: Object.keys(skills),
		[SOURCE]: Object.keys(groups),
	};
	const directories = [ROOT, PLUGIN, `${PLUGIN}/skills`, SOURCE];
	const files: Record<string, string> = {
		[`${ROOT}/${CONFIG_PATH}`]: allowList ?? JSON.stringify({exempt: {}, unmigrated: {}}),
	};
	if (repoNames !== undefined) {
		files[`${ROOT}/.fabrika.jsonc`] = JSON.stringify({portability: {repoNames}});
	}
	for (const [group, held] of Object.entries(skills)) {
		const dir = `${PLUGIN}/skills/${group}`;
		directories.push(dir);
		dirs[dir] = Object.keys(held);
		for (const [name, content] of Object.entries(held)) files[`${dir}/${name}`] = content;
	}
	for (const [group, held] of Object.entries(groups)) {
		const dir = `${SOURCE}/${group}`;
		directories.push(dir);
		dirs[dir] = Object.keys(held);
		for (const [name, content] of Object.entries(held)) files[`${dir}/${name}`] = content;
	}
	return {dirs, files, directories};
};

const swept: Tree = {
	skills: {build: {"SKILL.md": "Prove the ground, then pick.\n"}},
	groups: {lane: {"report.ts": "export const report = () => 0;\n"}},
};

describe("runPortabilityGuard", () => {
	it("passes a corpus that reads the same in any repository, naming what it walked", async () => {
		const outcome = await run(scriptTree(swept));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("clean — 2 file(s)");
		expect(outcome.stderr).toEqual([]);
	});

	it("reds a reference no allow-list row covers, with nothing on stdout", async () => {
		const outcome = await run(
			scriptTree({...swept, skills: {build: {"SKILL.md": "The lane parked twice (#6037).\n"}}}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(
			"claude-plugins/fabrika/skills/build/SKILL.md:1: #6037",
		);
	});

	it("reds a name the repo declared as its own", async () => {
		const outcome = await run(
			scriptTree({
				...swept,
				skills: {build: {"SKILL.md": "In phoenix the gate runs on push.\n"}},
				repoNames: ["phoenix"],
			}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("phoenix");
	});

	it("emits one ::error per finding under Actions, and none outside it", async () => {
		const dirty = scriptTree({...swept, skills: {build: {"SKILL.md": "per ADR 0092.\n"}}});
		const annotated = await run(dirty, {GITHUB_ACTIONS: "true"});
		expect(annotated.stderr.some((line) => line.startsWith("::error file="))).toBe(true);
		const plain = await run(dirty, {GITHUB_ACTIONS: "false"});
		expect(plain.stderr.some((line) => line.startsWith("::error"))).toBe(false);
	});

	it("reds a walk of either root that matched no file rather than passing it", async () => {
		const noPlugin = await run(
			scriptTree({groups: {lane: {"report.ts": "export const a = 0;\n"}}}),
		);
		expect(noPlugin.code).toBe(ZERO_SCOPE);
		expect(noPlugin.stderr.join("\n")).toContain("claude-plugins/fabrika/ matched ZERO");
		const noSource = await run(scriptTree({skills: {build: {"SKILL.md": "clean\n"}}}));
		expect(noSource.code).toBe(ZERO_SCOPE);
		expect(noSource.stderr.join("\n")).toContain("packages/fabrika-cli/src/ matched ZERO");
	});

	it("reds a directory the walk never entered, so a green cannot come from an empty corner", async () => {
		const outcome = await run(scriptTree({...swept, skills: {...swept.skills, ship: {}}}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("claude-plugins/fabrika/skills/ship");
	});

	it("reds a root that resolves to another tree", async () => {
		const outcome = await run({
			...scriptTree(swept),
			real: {[SOURCE]: "/elsewhere/src"},
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("resolves to /elsewhere/src");
	});

	it("reds an allow-list entry with no `why`, rather than reading it as a carve-out", async () => {
		const outcome = await run(
			scriptTree({
				...swept,
				allowList: JSON.stringify({exempt: {"a.md": {ceiling: 1}}, unmigrated: {}}),
			}),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain(CONFIG_PATH);
	});

	it("reds a floor row whose ceiling sits above what the tree carries", async () => {
		const outcome = await run(
			scriptTree({
				...swept,
				allowList: JSON.stringify({
					exempt: {},
					unmigrated: {
						"plugin-build": {
							ceiling: 3,
							why: "cleared by the build sweep child",
							paths: ["claude-plugins/fabrika/skills/build"],
						},
					},
				}),
			}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("lower the ceiling to 0 or delete the row");
	});
});

/** The head a reviewer's verdict names — a commit its worktree, cut from the driver's checkout, does not stand on. */
const HEAD = "4011b1d8238aaf1d71de8704bedb1aa1dd98fda9";

/**
 * A commit holding `tree`'s files, scripted as the object database serves them: the listing, each
 * blob, the allow-list, and a `.fabrika.jsonc` only when the tree declares repo names.
 */
const commitRows = ({
	skills = {},
	groups = {},
	allowList,
	repoNames,
}: Tree): ReadonlyArray<readonly [RegExp, ExecResult]> => {
	const blobs: Record<string, string> = {
		[CONFIG_PATH]: allowList ?? JSON.stringify({exempt: {}, unmigrated: {}}),
	};
	for (const [group, held] of Object.entries(skills)) {
		for (const [name, content] of Object.entries(held)) {
			blobs[`claude-plugins/fabrika/skills/${group}/${name}`] = content;
		}
	}
	for (const [group, held] of Object.entries(groups)) {
		for (const [name, content] of Object.entries(held)) {
			blobs[`packages/fabrika-cli/src/${group}/${name}`] = content;
		}
	}
	const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const rows: Array<readonly [RegExp, ExecResult]> = [
		[new RegExp(`^git rev-parse --verify --quiet ${HEAD}\\^\\{commit\\}$`), okOut(`${HEAD}\n`)],
		[
			new RegExp(`^git ls-tree --full-tree ${HEAD} -- \\.fabrika\\.jsonc$`),
			okOut(repoNames === undefined ? "" : `100644 blob ${"e".repeat(40)}\t.fabrika.jsonc\n`),
		],
		[
			new RegExp(`^git ls-tree -r --full-tree --name-only -z ${HEAD}$`),
			okOut(`${Object.keys(blobs).join("\0")}\0`),
		],
	];
	if (repoNames !== undefined) {
		rows.push([
			new RegExp(`^git show ${HEAD}:\\.fabrika\\.jsonc$`),
			okOut(JSON.stringify({portability: {repoNames}})),
		]);
	}
	for (const [path, content] of Object.entries(blobs)) {
		rows.push([new RegExp(`^git show ${HEAD}:${literal(path)}$`), okOut(content)]);
	}
	return rows;
};

const scriptCommit = (tree: Tree): FakeShell => fakeShell(commitRows(tree));

const check = (
	shell: FakeShell,
	tree: FakeFsOptions,
	flags: {readonly root?: string | null; readonly sha?: string | null} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runPortabilityCheck({
				root: flags.root ?? null,
				sha: flags.sha === undefined ? HEAD : flags.sha,
				cwd: ROOT,
				env: {},
			}),
			Layer.merge(shell.layer, fakeFs(tree).layer),
		),
	);

/** What the head adds: a new source file carrying a reference only this repository resolves. */
const headAdds: Tree = {
	...swept,
	groups: {...swept.groups, ci: {"gate.ts": "// the gate parked twice (#6037)\n"}},
};

describe("runPortabilityCheck --sha — the head is read, never the tree the reviewer stands on", () => {
	it("reds the head's new file from a tree that holds none of it", async () => {
		const standingOn = scriptTree(swept);
		expect((await run(standingOn)).code).toBe(0);

		const outcome = await check(scriptCommit(headAdds), standingOn);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("packages/fabrika-cli/src/ci/gate.ts");
		expect(outcome.stderr.join("\n")).toContain(`at ${HEAD}`);
	});

	it("answers exactly as the tree walk does when the tree already stands on the head", async () => {
		const tree = run(scriptTree(swept));
		const head = check(scriptCommit(swept), scriptTree(swept));
		const [walked, read] = await Promise.all([tree, head]);
		expect(read.code).toBe(0);
		expect(read.stdout).toBe(
			walked.stdout.replace("portability-guard check:", `portability-guard check at ${HEAD}:`),
		);
	});

	it("reads the head's own allow-list and repo names, not the tree's", async () => {
		const outcome = await check(
			scriptCommit({...swept, repoNames: ["kamp.us"], groups: {lane: {"a.ts": "// kamp.us\n"}}}),
			scriptTree({...swept, groups: {lane: {"a.ts": "// kamp.us\n"}}}),
		);
		expect(outcome.code).toBe(VIOLATION);
	});

	it("names the commit on a clean answer, so the verdict can cite what it read", async () => {
		const outcome = await check(scriptCommit(swept), scriptTree(swept));
		expect(outcome.stdout).toContain(`portability-guard check at ${HEAD}: clean — 2 file(s)`);
	});
});

describe("runPortabilityCheck --sha — a head it cannot read is a stop, never a tree scan", () => {
	it("refuses at 11 when the commit is not in this clone, reading no file of the tree", async () => {
		const shell = fakeShell([[/^git rev-parse --verify --quiet /, errOut("")]]);
		const outcome = await check(shell, scriptTree(swept));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("the working tree is never read in its place");
		expect(shell.calls.some((line) => /^git show /.test(line))).toBe(false);
	});

	it("refuses at 11 when one of the head's files cannot be read", async () => {
		const shell = fakeShell([
			[/^git show [0-9a-f]+:packages\/fabrika-cli\/src\/lane\/report\.ts$/, errOut("bad object")],
			...commitRows(swept),
		]);
		const outcome = await check(shell, scriptTree(swept));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("lane/report.ts");
	});

	it("reds a head whose listing has no file under a scan root", async () => {
		const outcome = await check(
			scriptCommit({skills: {build: {"SKILL.md": "Prove the ground.\n"}}}),
			scriptTree(swept),
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("refuses at 10 a --sha that is not a revision", async () => {
		const shell = fakeShell([]);
		const outcome = await check(shell, scriptTree(swept), {sha: "HEAD"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(shell.calls).toEqual([]);
	});

	it("refuses at 10 a --sha beside --root — two subjects", async () => {
		const outcome = await check(fakeShell([]), scriptTree(swept), {root: ROOT});
		expect(outcome.code).toBe(OFF_VOCABULARY);
	});

	it("leaves the working-tree walk unchanged with no --sha", async () => {
		const shell = fakeShell([]);
		const outcome = await check(shell, scriptTree(swept), {sha: null, root: ROOT});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("portability-guard check: clean — 2 file(s)");
		expect(shell.calls).toEqual([]);
	});
});
