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

interface RootSpec {
	/** The skill text written to skills/plan-epic/SKILL.md (the consumption signal). */
	readonly skill?: string;
	/** packages/<name>/package.json contents, keyed by package name. */
	readonly pkgs?: Readonly<Record<string, unknown>>;
}

// Build a fixture repo root: skills/** carrying the consumption signal, and a packages/
// dir whose presence + publishability we vary per test.
const makeRoot = (parent: string, spec: RootSpec): string => {
	const root = mkdtempSync(join(parent, "publish-guard-root-"));
	const skills = join(root, "claude-plugins", "kampus-pipeline", "skills", "plan-epic");
	mkdirSync(skills, {recursive: true});
	writeFileSync(
		join(skills, "SKILL.md"),
		spec.skill ?? "runs @kampus/epic-ledger and @kampus/decisions-index",
		"utf8",
	);
	for (const [name, manifest] of Object.entries(spec.pkgs ?? {})) {
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
		const root = makeRoot(base, {
			pkgs: {
				"epic-ledger": {publishConfig: {access: "public"}},
				"decisions-index": {publishConfig: {access: "public"}},
			},
		});
		const {code, stdout} = await run(["list"], root);
		assert.strictEqual(code, 0);
		assert.include(stdout, "@kampus/decisions-index");
		assert.include(stdout, "@kampus/epic-ledger");
	}, 30_000);

	it("check exits 0 with a clean table when every required package is publishable", async () => {
		const root = makeRoot(base, {
			pkgs: {
				"epic-ledger": {publishConfig: {access: "public"}},
				"decisions-index": {publishConfig: {access: "public"}},
			},
		});
		const {code, stdout} = await run(["check"], root);
		assert.strictEqual(code, 0);
		assert.include(stdout, "clean");
		assert.include(stdout, "@kampus/epic-ledger");
	}, 30_000);

	it("check exits non-zero with a drift table when a required package is private", async () => {
		const root = makeRoot(base, {
			pkgs: {
				"epic-ledger": {private: true, publishConfig: {access: "public"}},
				"decisions-index": {publishConfig: {access: "public"}},
			},
		});
		const {code, stdout, stderr} = await run(["check"], root);
		assert.strictEqual(code, 1);
		assert.include(stdout, "DRIFT");
		assert.include(stdout, "@kampus/epic-ledger");
		assert.include(stderr, "blocked");
	}, 30_000);

	it("check ignores an incidental @kampus/web mention (apps/web — no packages/web), staying clean", async () => {
		// the PR #974 trigger: a CI check name quoted verbatim in a skill file. @kampus/web
		// resolves to apps/web (no packages/web), so it must NOT enter the required set.
		const root = makeRoot(base, {
			skill:
				"runs @kampus/epic-ledger; the GitHub check is named `cleanup (web, @kampus/web, true)`",
			pkgs: {"epic-ledger": {publishConfig: {access: "public"}}},
		});
		const {code, stdout} = await run(["check"], root);
		assert.strictEqual(code, 0);
		assert.include(stdout, "clean");
		assert.notInclude(stdout, "@kampus/web");
	}, 30_000);

	it("check exits non-zero with a BREAK when a bare-path invocation has no published fallback", async () => {
		const root = makeRoot(base, {
			skill: "validate: `node packages/epic-ledger/src/bin.ts validate` (no dlx fallback)",
			pkgs: {"epic-ledger": {publishConfig: {access: "public"}}},
		});
		const {code, stdout, stderr} = await run(["check"], root);
		assert.strictEqual(code, 1);
		assert.include(stdout, "BREAK");
		assert.include(stdout, "@kampus/epic-ledger");
		assert.include(stderr, "foreign-repo break");
	}, 30_000);

	it("check stays clean when a bare-path invocation carries a pnpm dlx fallback", async () => {
		const root = makeRoot(base, {
			skill:
				"locally `node packages/epic-ledger/src/bin.ts`, foreign `pnpm dlx @kampus/epic-ledger@latest`",
			pkgs: {"epic-ledger": {publishConfig: {access: "public"}}},
		});
		const {code, stdout} = await run(["check"], root);
		assert.strictEqual(code, 0);
		assert.include(stdout, "clean");
	}, 30_000);
});
