/**
 * The packaged copy still boots a lane — the half of `lane open` that only a real build and a real
 * pack can prove.
 *
 * `lane/command.ts` resolves its workflow templates by path off `import.meta.url`, and `tsc` copies
 * no file it does not compile, so `dist/lane/templates/` never existed and every install outside
 * this checkout booted nothing (#6011). No in-process test could see it: read from `src/`, the
 * templates are right there. What is under test is the *build output*, so this suite builds and
 * packs for real and drives the tarball's own `dist/bin.js`.
 *
 * The tarball is unpacked with the package's own `node_modules` symlinked beside it rather than
 * installed from a registry: what the defect is about is which files the tarball carries, and a
 * real dependency install proves nothing further while putting the network on a gate path
 * (`.patterns/subprocess-test-budget.md`).
 */
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {beforeAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(PACKAGE_ROOT, "src");
const DIST = join(PACKAGE_ROOT, "dist");

/**
 * Walked here rather than imported from `scripts/copy-src-assets.mjs`: that script's own idea of
 * what an asset is is the thing under test, so sharing it would let a defect in it hide itself.
 */
const assetsUnder = (root: string): readonly string[] =>
	readdirSync(root, {recursive: true, withFileTypes: true})
		.filter((entry) => entry.isFile() && !entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
		.sort();

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * `FABRIKA_SKIP_INFER` pins the invocation to the unpacked tarball rather than this checkout, and the
 * emptied `PATH` keeps the run off the network: an issue key makes `lane open` ask the board whether
 * the issue is an epic (#7024), and with no `git` and no `gh` to resolve a repo or a token, that read
 * refuses the same way in every environment instead of hitting the API from a packaging test.
 */
const bootLane = (key: string, root: string): Run => {
	try {
		const stdout = execFileSync(
			process.execPath,
			[join(tarballRoot, "dist", "bin.js"), "lane", "open", key, "--root", root],
			{
				encoding: "utf8",
				env: {
					...process.env,
					FABRIKA_SKIP_INFER: "1",
					CLAUDE_PIPELINE_REPO: "",
					GITHUB_REPOSITORY: "",
					GITHUB_TOKEN: "",
					GH_TOKEN: "",
					PATH: "",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

const committedTemplate = (name: string): string =>
	readFileSync(join(SRC, "lane", "templates", name), "utf8");

let tarballRoot = "";
let scratch = "";

describe("the packed package ships what it reads at run time (#6011)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	beforeAll(() => {
		const tmp = mkdtempSync(join(tmpdir(), "fabrika-6011-"));
		const pnpm = (args: readonly string[]): string =>
			execFileSync("pnpm", [...args], {
				cwd: PACKAGE_ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		pnpm(["run", "build"]);
		const tarball = pnpm(["pack", "--pack-destination", tmp]).trim().split("\n").at(-1)?.trim();
		if (tarball === undefined || tarball === "") throw new Error("pnpm pack named no tarball");
		execFileSync("tar", ["-xzf", tarball, "-C", tmp], {stdio: ["ignore", "pipe", "pipe"]});
		tarballRoot = join(tmp, "package");
		symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(tarballRoot, "node_modules"), "dir");
		scratch = join(tmp, "scratch");
	}, SUBPROCESS_TEST_TIMEOUT_MS);

	/**
	 * The general guard: an asset added under `src/` tomorrow and read by path is caught the same
	 * way the two templates are, without anyone naming it here. Zero assets is a red, not a pass
	 * (ADR 0092) — a walk that stopped finding files reads exactly like a build that ships them.
	 */
	it("copies every non-TypeScript file under src/ into dist/, byte for byte", () => {
		const assets = assetsUnder(SRC);
		expect(assets.length).toBeGreaterThan(0);
		expect(assets.filter((asset) => !existsSync(join(DIST, asset)))).toEqual([]);
		const differing = assets.filter(
			(asset) => !readFileSync(join(SRC, asset)).equals(readFileSync(join(DIST, asset))),
		);
		expect(differing).toEqual([]);
	});

	it("carries those assets inside the tarball, past the `files` field", () => {
		const absent = assetsUnder(SRC).filter(
			(asset) => !existsSync(join(tarballRoot, "dist", asset)),
		);
		expect(absent).toEqual([]);
	});

	it("ships the coder template inside the tarball, byte-identical to the committed one", () => {
		expect(
			readFileSync(join(tarballRoot, "dist", "lane", "templates", "coder.workflow.json"), "utf8"),
		).toBe(committedTemplate("coder.workflow.json"));
	});

	it("resolves the coder template's path from the tarball on an issue boot", () => {
		// An issue key cannot reach the write here: `lane open` asks the board whether the issue is an
		// epic, and this run has nothing to ask it with (#7024). The template read runs first and is
		// the thing #6011 is about, so its silence is what this asserts — the bytes are the test above.
		const run = bootLane("6011", join(scratch, "lanes"));

		expect(run.stderr).not.toContain("cannot read the committed template");
		expect(run.stderr).toContain("cannot establish whether #6011 is an epic");
	});

	it("boots a chore lane from the tarball, byte-identical to the committed template", () => {
		const run = bootLane("chore:park-sweep", join(scratch, "chores"));
		expect(run.stderr).not.toContain("cannot read the committed template");
		expect(run.code).toBe(0);
		expect(readFileSync(join(scratch, "chores", "park-sweep", "workflow.json"), "utf8")).toBe(
			committedTemplate("chore.workflow.json"),
		);
	});
});
