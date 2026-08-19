/**
 * `ci annotate`, ported from v1's `tsc-annotate map` (#6099) — the two contracts that
 * matter: the log always goes through, and annotations only appear where they render.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {runAnnotate} from "./annotate-verb.ts";

const ROOT = "/repo";

const repo = (members: Readonly<Record<string, string>>): FakeFsOptions => {
	const files: Record<string, string> = {
		[`${ROOT}/pnpm-workspace.yaml`]: "packages:\n  - packages/*\n",
	};
	const directories = [`${ROOT}/packages`];
	for (const [dir, name] of Object.entries(members)) {
		directories.push(`${ROOT}/packages/${dir}`);
		files[`${ROOT}/packages/${dir}/package.json`] = JSON.stringify({name});
	}
	return {files, dirs: {[`${ROOT}/packages`]: Object.keys(members)}, directories};
};

const run = async (
	output: string,
	options: {
		readonly members?: Readonly<Record<string, string>>;
		readonly env?: Record<string, string | undefined>;
		readonly force?: boolean;
	} = {},
) => {
	const written: Array<string> = [];
	const warned: Array<string> = [];
	await Effect.runPromise(
		Effect.provide(
			runAnnotate({
				force: options.force ?? false,
				root: ROOT,
				cwd: ROOT,
				env: options.env ?? {GITHUB_ACTIONS: "true"},
				passThrough: Effect.succeed(output),
				write: (line) => written.push(line),
				warn: (line) => warned.push(line),
			}),
			fakeFs(repo(options.members ?? {web: "@kampus/web"})).layer,
		),
	);
	return {written, warned};
};

describe("runAnnotate", () => {
	it("maps a turbo-grouped diagnostic onto a repo-relative ::error command", async () => {
		const {written} = await run(
			["@kampus/web:typecheck", "src/App.tsx(12,5): error TS2322: Type 'x' is not 'y'."].join("\n"),
		);
		expect(written).toEqual([
			"::error file=packages/web/src/App.tsx,line=12,col=5::TS2322: Type 'x' is not 'y'.",
		]);
	});

	it("emits nothing outside GitHub Actions unless --force", async () => {
		const off = await run("src/App.tsx(1,1): error TS1: nope", {env: {}});
		expect(off.written).toEqual([]);
		const forced = await run("src/App.tsx(1,1): error TS1: nope", {env: {}, force: true});
		expect(forced.written).toHaveLength(1);
	});

	it("warns without failing when no named member can be resolved", async () => {
		const {warned, written} = await run("src/App.tsx(1,1): error TS1: nope", {members: {}});
		expect(warned.join("\n")).toContain("found no named workspace members");
		expect(written).toHaveLength(1);
	});

	it("emits nothing for output carrying no diagnostic", async () => {
		const {written} = await run("Tasks:    3 successful, 3 total\nCached:    3 cached");
		expect(written).toEqual([]);
	});
});
