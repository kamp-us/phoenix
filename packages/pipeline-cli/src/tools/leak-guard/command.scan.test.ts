import {execFile} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

// `pipeline-cli leak-guard scan <file>...` is the CI-callable surface.
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const runScan = (files: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "leak-guard", "scan", ...files], (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
	});

describe("leak-guard scan CLI — exit-code contract (#332)", () => {
	let dir: string;
	const write = (name: string, content: string): string => {
		const p = join(dir, name);
		writeFileSync(p, content, "utf8");
		return p;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "leak-guard-scan-"));
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("exits 2 (LEAK_EXIT_CODE) and reports a leak in a .md", async () => {
		const file = write("leaky.md", "see /Users/foo/x for details");
		const {code, stderr} = await runScan([file]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "/Users/foo");
		assert.include(stderr, file);
	}, 30_000);

	it("exits 0 on a clean .md", async () => {
		const file = write("clean.md", "ordinary prose, apps/web/worker, .claude/skills");
		const {code} = await runScan([file]);
		assert.strictEqual(code, 0);
	}, 30_000);

	it("exits 0 on a non-doc .ts containing /Users (out of scope)", async () => {
		const file = write("fixture.ts", 'const p = "/Users/foo/x"');
		const {code} = await runScan([file]);
		assert.strictEqual(code, 0);
	}, 30_000);

	it("skips a missing file without crashing (exit 0)", async () => {
		const {code} = await runScan([join(dir, "does-not-exist.md")]);
		assert.strictEqual(code, 0);
	}, 30_000);

	it("flags the leaking file among several clean ones", async () => {
		const clean = write("ok.md", "no paths here");
		const leaky = write("bad.md", "rebuilt from ~/code/github.com/kamp-us/kampus");
		const {code, stderr} = await runScan([clean, leaky]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "~/code/");
		assert.include(stderr, leaky);
	}, 30_000);
});
