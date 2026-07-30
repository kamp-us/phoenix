import {execFile} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";

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

describe("leak-guard scan CLI — exit-code contract (#332)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
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
	});

	it("exits 0 on a clean .md", async () => {
		const file = write("clean.md", "ordinary prose, apps/web/worker, .claude/skills");
		const {code} = await runScan([file]);
		assert.strictEqual(code, 0);
	});

	it("exits 0 on a non-doc .ts containing /Users (out of scope)", async () => {
		const file = write("fixture.ts", 'const p = "/Users/foo/x"');
		const {code} = await runScan([file]);
		assert.strictEqual(code, 0);
	});

	it("skips a missing file without crashing (exit 0)", async () => {
		const {code} = await runScan([join(dir, "does-not-exist.md")]);
		assert.strictEqual(code, 0);
	});

	it("flags the leaking file among several clean ones", async () => {
		const clean = write("ok.md", "no paths here");
		const leaky = write("bad.md", "rebuilt from ~/code/github.com/kamp-us/kampus");
		const {code, stderr} = await runScan([clean, leaky]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "~/code/");
		assert.include(stderr, leaky);
	});

	// #4496 at the CLI boundary: the same bytes that exit 2 in a `.md` must exit 2 in a `.sh`.
	// Before the shell surface landed this exact fixture exited 0.
	it("exits 2 on a leak in a .sh (the surface #4435's extraction moved shell onto)", async () => {
		const file = write("planted.sh", '#!/usr/bin/env bash\nroot="/Users/foo/code/x"\n');
		const {code, stderr} = await runScan([file]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "/Users/foo");
		assert.include(stderr, file);
	});

	it("exits 0 on a clean .sh", async () => {
		const file = write("clean.sh", '#!/usr/bin/env bash\nroot="packages/pipeline-cli"\n');
		const {code} = await runScan([file]);
		assert.strictEqual(code, 0);
	});

	// A non-zero exit with zero bytes of stdout is the class that FAIL'd #4485 twice: a caller
	// reading empty stdout as a positive answer has nothing to misread. The scope line is emitted
	// ahead of the verdict on both paths, so stdout is never empty — and it names each surface
	// separately, which is what makes a narrowing surface visible at all (#4496, ADR 0092 §1).
	it("prints the per-surface scope on stdout on BOTH the clean and the blocked path", async () => {
		const leaky = write("scope-leaky.sh", "cd /Users/foo/x\n");
		const doc = write("scope-ok.md", "prose");
		const src = write("scope-oos.ts", "const x = 1");
		const blocked = await runScan([leaky, doc, src]);
		assert.strictEqual(blocked.code, 2);
		assert.isAbove(blocked.stdout.trim().length, 0);
		assert.include(blocked.stdout, "1 doc surface");
		assert.include(blocked.stdout, "1 shell surface");
		assert.include(blocked.stdout, "1 out of scope");

		const clean = await runScan([doc]);
		assert.strictEqual(clean.code, 0);
		assert.include(clean.stdout, "1 doc surface");
		assert.include(clean.stdout, "0 shell surface");
	});
});
