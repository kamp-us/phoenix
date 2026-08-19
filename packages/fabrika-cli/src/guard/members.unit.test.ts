import {Effect, Exit} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {scanWorkspaceMembers, undeclaredGlobs} from "./members.ts";

const ROOT = "/repo";
const WORKSPACE = `${ROOT}/pnpm-workspace.yaml`;

const workspace = (globs: ReadonlyArray<string>) =>
	`packages:\n${globs.map((g) => `  - ${g}`).join("\n")}\n`;

const scan = (options: FakeFsOptions, under?: ReadonlyArray<string>) =>
	Effect.runPromiseExit(Effect.provide(scanWorkspaceMembers(ROOT, under), fakeFs(options).layer));

const dirs = (names: ReadonlyArray<string>) => ({[`${ROOT}/packages`]: names});

describe("undeclaredGlobs", () => {
	it("names only what the workspace does not declare", () => {
		expect(undeclaredGlobs(["packages/*", "apps/*"], ["packages/*"])).toEqual([]);
		expect(undeclaredGlobs(["apps/*"], ["packages/*"])).toEqual(["packages/*"]);
	});
});

describe("scanWorkspaceMembers", () => {
	it("finds the members under a declared glob and reports what it walked", async () => {
		const exit = await scan(
			{
				files: {
					[WORKSPACE]: workspace(["packages/*", "apps/*"]),
					[`${ROOT}/packages/a/package.json`]: "{}",
					[`${ROOT}/packages/b/package.json`]: "{}",
				},
				dirs: dirs(["a", "b"]),
				directories: [`${ROOT}/packages`, `${ROOT}/packages/a`, `${ROOT}/packages/b`],
			},
			["packages/*"],
		);
		expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
			declared: ["packages/*", "apps/*"],
			walked: ["packages/*"],
			members: [
				{dir: "packages/a", glob: "packages/*"},
				{dir: "packages/b", glob: "packages/*"},
			],
		});
	});

	// A directory left behind by a consolidation carries a stale `.turbo/` log and nothing else. A
	// guard that counted one would red on litter rather than on a real gap.
	it("ignores a dead-shell directory that carries no package.json", async () => {
		const exit = await scan(
			{
				files: {
					[WORKSPACE]: workspace(["packages/*"]),
					[`${ROOT}/packages/real/package.json`]: "{}",
				},
				dirs: dirs(["real", "dead-shell"]),
				directories: [`${ROOT}/packages`, `${ROOT}/packages/real`, `${ROOT}/packages/dead-shell`],
			},
			["packages/*"],
		);
		expect(Exit.isSuccess(exit) && exit.value.members.map((m) => m.dir)).toEqual(["packages/real"]);
	});

	it("ignores a plain file sitting beside the member directories", async () => {
		const exit = await scan(
			{
				files: {
					[WORKSPACE]: workspace(["packages/*"]),
					[`${ROOT}/packages/README.md`]: "# packages",
					[`${ROOT}/packages/a/package.json`]: "{}",
				},
				dirs: dirs(["README.md", "a"]),
				directories: [`${ROOT}/packages`, `${ROOT}/packages/a`],
			},
			["packages/*"],
		);
		expect(Exit.isSuccess(exit) && exit.value.members.map((m) => m.dir)).toEqual(["packages/a"]);
	});

	it("resolves a literal (non-glob) member path", async () => {
		const exit = await scan(
			{
				files: {
					[WORKSPACE]: workspace(["tools/one"]),
					[`${ROOT}/tools/one/package.json`]: "{}",
				},
				directories: [`${ROOT}/tools/one`],
			},
			["tools/one"],
		);
		expect(Exit.isSuccess(exit) && exit.value.members).toEqual([
			{dir: "tools/one", glob: "tools/one", name: null},
		]);
	});

	it("carries each member's declared package name, and null when the manifest declares none", async () => {
		const exit = await scan(
			{
				files: {
					[WORKSPACE]: workspace(["packages/*"]),
					[`${ROOT}/packages/a/package.json`]: '{"name":"@kampus/a"}',
					[`${ROOT}/packages/b/package.json`]: "{ not json",
				},
				dirs: dirs(["a", "b"]),
				directories: [`${ROOT}/packages`, `${ROOT}/packages/a`, `${ROOT}/packages/b`],
			},
			["packages/*"],
		);
		expect(Exit.isSuccess(exit) && exit.value.members).toEqual([
			{dir: "packages/a", glob: "packages/*", name: "@kampus/a"},
			{dir: "packages/b", glob: "packages/*", name: null},
		]);
	});

	it("walks every declared glob when the caller restricts to none", async () => {
		const exit = await scan({
			files: {
				[WORKSPACE]: workspace(["packages/*", "apps/*"]),
				[`${ROOT}/packages/a/package.json`]: "{}",
				[`${ROOT}/apps/web/package.json`]: "{}",
			},
			dirs: {[`${ROOT}/packages`]: ["a"], [`${ROOT}/apps`]: ["web"]},
			directories: [`${ROOT}/packages`, `${ROOT}/packages/a`, `${ROOT}/apps`, `${ROOT}/apps/web`],
		});
		expect(Exit.isSuccess(exit) && exit.value.members.map((m) => m.dir)).toEqual([
			"apps/web",
			"packages/a",
		]);
	});

	it("resolves an absent glob directory to no members rather than failing", async () => {
		const exit = await scan({files: {[WORKSPACE]: workspace(["packages/*"])}});
		expect(Exit.isSuccess(exit) && exit.value.members).toEqual([]);
	});

	// The vacuous pass ADR 0092 forbids: an unreadable directory answered as "no members" is
	// indistinguishable from a workspace that genuinely holds none, and they take opposite branches.
	it("FAILS on an unreadable member directory instead of resolving to an empty scan", async () => {
		const exit = await scan(
			{
				files: {[WORKSPACE]: workspace(["packages/*"])},
				dirs: {[`${ROOT}/packages`]: null},
				directories: [`${ROOT}/packages`],
			},
			["packages/*"],
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("FAILS when the workspace manifest itself cannot be read", async () => {
		const exit = await scan({unreadable: [WORKSPACE], files: {[WORKSPACE]: "x"}}, ["packages/*"]);
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
