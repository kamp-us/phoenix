import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it} from "vitest";

import {APP_SCOPE, EXIT} from "./app-boundary.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";

const app = (name: string): string => `${APP_SCOPE}${name}`;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

// A hook runs this suite with `GIT_DIR` and friends set, which would point every call at the
// hook's own repository instead of the throwaway one.
const gitEnv = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

const git = (root: string, args: ReadonlyArray<string>): void => {
	const child = spawnSync("git", args, {cwd: root, encoding: "utf8", env: gitEnv});
	expect(child.status, child.stderr).toBe(0);
};

/**
 * A throwaway git repo: one app, one package, and whatever `files` adds on top. Everything is staged
 * except the paths in `untracked`, which stay on disk for git to list as untracked or ignore.
 */
const workspace = (
	files: Readonly<Record<string, string>>,
	untracked: Readonly<Record<string, string>> = {},
): string => {
	const root = mkdtempSync(join(tmpdir(), "app-boundary-"));
	roots.push(root);
	const base: Record<string, string> = {
		"pnpm-workspace.yaml": "packages:\n  - packages/*\n  - apps/*\n",
		"package.json": JSON.stringify({name: "root"}),
		"apps/desk/package.json": JSON.stringify({name: app("desk")}),
		"apps/desk/src/main.ts": `import {x} from "${app("desk")}/self";\n`,
		"packages/foo/package.json": JSON.stringify({name: "@kampus/foo"}),
		"packages/foo/src/index.ts": "export const x = 1;\n",
		"packages/foo/node_modules/dep/index.js": `import "${app("desk")}";\n`,
	};
	const write = (entries: Readonly<Record<string, string>>): void => {
		for (const [path, text] of Object.entries(entries)) {
			mkdirSync(dirname(join(root, path)), {recursive: true});
			writeFileSync(join(root, path), text);
		}
	};
	write({...base, ...files});
	git(root, ["init", "--quiet"]);
	git(root, ["add", "--all", "--force"]);
	write(untracked);
	return root;
};

const run = (root: string) => {
	const child = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./bin.ts", import.meta.url)), "--root", root],
		{encoding: "utf8", env: {PATH: process.env.PATH}},
	);
	expect(child.error).toBeUndefined();
	return {status: child.status, output: `${child.stdout}${child.stderr}`};
};

/** A relative path from `from`'s directory up to the repo root and down into `to`. */
const pathTo = (from: string, to: string): string =>
	`${from.includes("/") ? "../".repeat(from.split("/").length - 1) : "./"}${to}`;

describe("app-boundary-guard bin", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("passes a tree where only the app names its own scope", () => {
		const {status, output} = run(workspace({}));
		expect(output).toContain("clean — 2 package manifests and 1 source files");
		expect(status).toBe(EXIT.clean);
	});

	it("reds on a package that lists an app as a dependency, naming the package and field", () => {
		const manifest = JSON.stringify({name: "@kampus/foo", peerDependencies: {[app("desk")]: "*"}});
		const {status, output} = run(workspace({"packages/foo/package.json": manifest}));
		expect(status).toBe(EXIT.violated);
		expect(output).toContain(
			`packages/foo/package.json: @kampus/foo lists \`${app("desk")}\` in peerDependencies`,
		);
	});

	it.each([
		"packages/foo/src/index.ts",
		"packages/foo/src/index.unit.test.ts",
		"packages/foo/.tuval/tuval.config.ts",
	])("reds on an app import in %s, naming the file", (file) => {
		const {status, output} = run(workspace({[file]: `import {x} from "${app("desk")}/kernel";\n`}));
		expect(status).toBe(EXIT.violated);
		expect(output).toContain(`${file}:1: imports \`${app("desk")}/kernel\``);
	});

	it("reds on a package's relative import that resolves into an app", () => {
		const file = "packages/foo/src/index.ts";
		const specifier = pathTo(file, "apps/desk/src/main.ts");
		const {status, output} = run(workspace({[file]: `import {x} from "${specifier}";\n`}));
		expect(status).toBe(EXIT.violated);
		expect(output).toContain(
			`${file}:1: imports \`${specifier}\`, which resolves to apps/desk/src/main.ts`,
		);
	});

	it.each([
		"scripts/check.ts",
		"benchmarks/run.mjs",
		"biome-plugins/rule.js",
		".pnpmfile.cjs",
		"claude-plugins/fabrika/hooks/x.js",
	])("reads root-level source outside every member: %s", (file) => {
		const withScope = run(workspace({[file]: `import "${app("desk")}";\n`}));
		expect(withScope.status).toBe(EXIT.violated);
		expect(withScope.output).toContain(`${file}:1: imports \`${app("desk")}\``);

		const specifier = pathTo(file, "apps/desk/src/main.ts");
		const withPath = run(workspace({[file]: `require("${specifier}");\n`}));
		expect(withPath.status).toBe(EXIT.violated);
		expect(withPath.output).toContain(`${file}:1: imports \`${specifier}\``);
	});

	it("reads an untracked file git does not ignore, and skips the ignored and worktree copies", () => {
		const offending = `import "${app("desk")}";\n`;
		const root = workspace(
			{".gitignore": "out/\n", ".claude/worktrees/w/scripts/copy.ts": offending},
			{"out/built.js": offending},
		);
		expect(run(root).status).toBe(EXIT.clean);

		writeFileSync(join(root, "scripts-new.ts"), offending);
		const {status, output} = run(root);
		expect(status).toBe(EXIT.violated);
		expect(output).toContain("scripts-new.ts:1");
	});

	it("is UNKNOWN when git cannot list the tree", () => {
		const root = workspace({});
		rmSync(join(root, ".git"), {recursive: true, force: true});
		const {status, output} = run(root);
		expect(status).toBe(EXIT.unknown);
		expect(output).toContain("git ls-files");
	});

	it("is UNKNOWN when a package manifest does not parse", () => {
		const {status, output} = run(workspace({"packages/foo/package.json": "{nope"}));
		expect(status).toBe(EXIT.unknown);
		expect(output).toContain("packages/foo/package.json does not parse");
	});

	it("is UNKNOWN when there is no workspace file to scope the scan", () => {
		const root = workspace({});
		rmSync(join(root, "pnpm-workspace.yaml"));
		expect(run(root).status).toBe(EXIT.unknown);
	});
});
