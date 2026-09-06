/**
 * `guard portability-guard check` — the two-root scope walk, its fail-closed floors and the exit
 * taxonomy, over a scripted filesystem.
 *
 * Each floor is asserted rather than trusted, because each one is a way this guard could go green
 * having judged nothing: a root that resolves elsewhere, an empty walk, a directory the walk never
 * entered, and an allow-list nobody could parse.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {CONFIG_PATH, runPortabilityGuard} from "./portability-verb.ts";

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
