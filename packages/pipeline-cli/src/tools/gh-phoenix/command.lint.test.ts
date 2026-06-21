import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

// `pipeline-cli gh-phoenix lint-skills` is the CI grep-lint surface (the gh-shim role
// stays served by the old package's bin until #1003 rewires the PATH shim).
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(
			"node",
			[BIN, "gh-phoenix", ...args],
			{env: {...process.env, ...env}},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stdout, stderr});
			},
		);
	});

describe("lint-skills CLI — fail-closed exit contract (ADR 0092)", () => {
	let dir: string;
	const write = (name: string, content: string): string => {
		const p = join(dir, name);
		writeFileSync(p, content, "utf8");
		return p;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "gh-phoenix-lint-"));
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("exits 3 (zero-scope FAIL) when every handed file is self-exempt", async () => {
		// a path ending in the exempt suffix /skills/write-code/SKILL.md → scope empty → fail-closed
		mkdirSync(join(dir, "skills", "write-code"), {recursive: true});
		const f = join(dir, "skills", "write-code", "SKILL.md");
		writeFileSync(f, "gh pr edit is documented here", "utf8");
		const {code, stderr} = await run(["lint-skills", f]);
		assert.strictEqual(code, 3);
		assert.include(stderr, "zero");
	}, 30_000);

	it("exits 2 and reports the finding on a GraphQL-path gh call", async () => {
		const f = write("dirty.md", "step one\nrun gh project list\n");
		const {code, stderr, stdout} = await run(["lint-skills", f]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "gh project");
		assert.include(stdout, "scanned 1 file");
	}, 30_000);

	it("exits 0 and emits scope on a clean skill file", async () => {
		const f = write("clean.md", "use gh api repos/o/r/issues/1");
		const {code, stdout} = await run(["lint-skills", f]);
		assert.strictEqual(code, 0);
		assert.include(stdout, "scanned 1 file");
		assert.include(stdout, "clean");
	}, 30_000);

	it("exits 3 (zero-scope FAIL) when every file is unreadable/missing", async () => {
		const {code, stderr} = await run(["lint-skills", join(dir, "does-not-exist.md")]);
		assert.strictEqual(code, 3);
		assert.include(stderr, "zero");
	}, 30_000);
});
