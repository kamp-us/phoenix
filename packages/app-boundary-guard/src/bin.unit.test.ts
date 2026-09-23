import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, expect, it} from "vitest";

import {APP_SCOPE, EXIT} from "./app-boundary.ts";

const app = (name: string): string => `${APP_SCOPE}${name}`;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

/** A throwaway workspace: one app, one package, and whatever `files` adds on top. */
const workspace = (files: Readonly<Record<string, string>>): string => {
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
	for (const [path, text] of Object.entries({...base, ...files})) {
		mkdirSync(dirname(join(root, path)), {recursive: true});
		writeFileSync(join(root, path), text);
	}
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
