import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, expect, it} from "vitest";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

const run = (files: string, diff: string, missing?: "files" | "diff") => {
	const directory = mkdtempSync(join(tmpdir(), "worker-relevance-"));
	directories.push(directory);
	const changedFile = join(directory, "files");
	const diffFile = join(directory, "diff");
	const output = join(directory, "output");
	if (missing !== "files") writeFileSync(changedFile, files);
	if (missing !== "diff") writeFileSync(diffFile, diff);
	const child = spawnSync(process.execPath, [fileURLToPath(new URL("./bin.ts", import.meta.url))], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			CHANGED_FILES_FILE: changedFile,
			LOCKFILE_DIFF_FILE: diffFile,
			GITHUB_OUTPUT: output,
		},
	});
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
	return readFileSync(output, "utf8");
};

it("reads a large lockfile delta without putting its bytes in the child environment", () => {
	const diff = `@@ -1 +1 @@ packages:\n+${"x".repeat(300_000)}\n`;
	expect(run("pnpm-lock.yaml", diff)).toBe("worker_relevant=true\n");
});

it("still skips a large diff confined to an irrelevant importer", () => {
	const files = `${"packages/demo-cli/src/tool.ts\n".repeat(10_000)}pnpm-lock.yaml`;
	const diff = `@@ -1 +1 @@ importers:\n+  packages/demo-cli:\n+    description: ${"x".repeat(300_000)}\n`;
	expect(run(files, diff)).toBe("worker_relevant=false\n");
});

it.each(["files", "diff"] as const)("runs when the %s input file cannot be read", (missing) => {
	expect(run("packages/demo-cli/src/tool.ts", "", missing)).toBe("worker_relevant=true\n");
});
