import {execFile} from "node:child_process";
import {copyFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";
import {CANT_RUN_EXIT_CODE, depsInstalled, RUNTIME_DEP} from "./preflight.ts";

describe("preflight — runtime-dep probe (#777)", () => {
	it("resolves the real runtime dep as installed", () => {
		assert.isTrue(depsInstalled(RUNTIME_DEP));
	});
	it("reports a non-existent package as NOT installed", () => {
		assert.isFalse(depsInstalled("@kampus/this-does-not-exist-777"));
	});
	it("never throws on a bogus specifier", () => {
		assert.doesNotThrow(() => depsInstalled("totally-bogus"));
	});
	it("the can't-run exit code is neither clean(0) nor leak(2) — the #332 contract", () => {
		assert.notStrictEqual(CANT_RUN_EXIT_CODE, 0);
		assert.notStrictEqual(CANT_RUN_EXIT_CODE, 2);
	});
});

const SRC = dirname(fileURLToPath(new URL("./bin.ts", import.meta.url)));

describe("bin — missing-dep degradation over the real entrypoint (#777)", () => {
	let isoDir: string;
	beforeAll(() => {
		isoDir = mkdtempSync(join(tmpdir(), "leak-guard-nodeps-"));
		// builtin-only modules; bin.run.ts (the platform-node importer) intentionally omitted.
		for (const f of ["bin.ts", "preflight.ts", "leak-guard.ts"]) {
			copyFileSync(join(SRC, f), join(isoDir, f));
		}
	});
	afterAll(() => rmSync(isoDir, {recursive: true, force: true}));

	it("exits with the can't-run code (NOT 0/2) and a loud stderr note", async () => {
		const target = join(isoDir, "doc.md");
		copyFileSync(join(SRC, "leak-guard.ts"), target); // any readable file to scan
		const {code, stderr} = await new Promise<{code: number; stderr: string}>((resolve) => {
			const {NODE_PATH: _drop, ...env} = process.env;
			execFile(
				"node",
				[join(isoDir, "bin.ts"), "scan", target],
				{env},
				(error, _stdout, errOut) => {
					const c =
						error && typeof (error as {code?: unknown}).code === "number"
							? (error as {code: number}).code
							: 0;
					resolve({code: c, stderr: errOut});
				},
			);
		});
		assert.strictEqual(code, CANT_RUN_EXIT_CODE);
		assert.notStrictEqual(code, 2);
		assert.include(stderr, "@effect/platform-node");
		assert.include(stderr, "pnpm install");
	}, 30_000);
});
