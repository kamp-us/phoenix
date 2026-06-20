import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>, root: string): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(
			"node",
			[BIN, ...args],
			{env: {...process.env, PUBLISH_GUARD_ROOT: root}},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stdout, stderr});
			},
		);
	});

// Build a fixture repo root: skills/** referencing two packages, and a packages/
// dir whose publishability we vary per test.
const makeRoot = (parent: string, pkgs: Readonly<Record<string, unknown>>): string => {
	const root = mkdtempSync(join(parent, "publish-guard-root-"));
	const skills = join(root, "claude-plugins", "kampus-pipeline", "skills", "plan-epic");
	mkdirSync(skills, {recursive: true});
	writeFileSync(
		join(skills, "SKILL.md"),
		"runs @kampus/epic-ledger and @kampus/decisions-index",
		"utf8",
	);
	for (const [name, manifest] of Object.entries(pkgs)) {
		mkdirSync(join(root, "packages", name), {recursive: true});
		writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify(manifest), "utf8");
	}
	return root;
};

describe("publish-guard bin", () => {
	let base: string;
	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "publish-guard-bin-"));
	});
	afterAll(() => {
		rmSync(base, {recursive: true, force: true});
	});

	it("list prints the derived required-published set", async () => {
		const root = makeRoot(base, {});
		const {code, stdout} = await run(["list"], root);
		assert.strictEqual(code, 0);
		assert.include(stdout, "@kampus/decisions-index");
		assert.include(stdout, "@kampus/epic-ledger");
	}, 30_000);

	it("check exits 0 with a clean table when every required package is publishable", async () => {
		const root = makeRoot(base, {
			"epic-ledger": {publishConfig: {access: "public"}},
			"decisions-index": {publishConfig: {access: "public"}},
		});
		const {code, stdout} = await run(["check"], root);
		assert.strictEqual(code, 0);
		assert.include(stdout, "clean");
		assert.include(stdout, "@kampus/epic-ledger");
	}, 30_000);

	it("check exits non-zero with a drift table when a required package is private", async () => {
		const root = makeRoot(base, {
			"epic-ledger": {private: true, publishConfig: {access: "public"}},
			"decisions-index": {publishConfig: {access: "public"}},
		});
		const {code, stdout, stderr} = await run(["check"], root);
		assert.strictEqual(code, 1);
		assert.include(stdout, "DRIFT");
		assert.include(stdout, "@kampus/epic-ledger");
		assert.include(stderr, "blocked");
	}, 30_000);

	it("check exits non-zero when a required package is not found", async () => {
		const root = makeRoot(base, {"decisions-index": {publishConfig: {access: "public"}}});
		const {code, stdout} = await run(["check"], root);
		assert.strictEqual(code, 1);
		assert.include(stdout, "DRIFT");
	}, 30_000);
});
