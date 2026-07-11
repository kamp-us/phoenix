import {execFile} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {delimiter, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, ...args], {env: {...process.env, ...env}}, (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
	});

describe("lint-skills CLI — fail-closed exit contract (ADR 0092)", () => {
	let dir: string;

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

	// Both the gh-call scan and the #1766 frontmatter check must have non-empty scope, so the
	// corpus is a real (non-self-exempt) SKILL.md carrying valid frontmatter — a plain .md
	// has empty frontmatter scope and would (correctly) fail closed with exit 3 (ADR 0092).
	const VALID_FM = ["---", "name: foo", "description: a test skill", "---", ""].join("\n");
	const writeSkill = (rel: string, body: string): string => {
		const p = join(dir, rel);
		mkdirSync(join(p, ".."), {recursive: true});
		writeFileSync(p, VALID_FM + body, "utf8");
		return p;
	};

	it("exits 2 and reports the finding on a GraphQL-path gh call", async () => {
		const f = writeSkill("skills/foo/SKILL.md", "step one\nrun gh project list\n");
		const {code, stderr, stdout} = await run(["lint-skills", f]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "gh project");
		assert.include(stdout, "scanned 1 file");
	}, 30_000);

	it("exits 0 and emits scope on a clean skill file", async () => {
		const f = writeSkill("skills/bar/SKILL.md", "use gh api repos/o/r/issues/1");
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

describe("gh shim — routes via the real gh stub", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "gh-phoenix-shim-"));
		// a fake `gh` that echoes its args (stands in for the real gh on PATH)
		const fakeGh = join(dir, "gh");
		writeFileSync(fakeGh, '#!/usr/bin/env bash\necho "FAKE_GH $*"\n', "utf8");
		chmodSync(fakeGh, 0o755);
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	const shimEnv = () => ({
		GH_PHOENIX_REAL_GH: join(dir, "gh"),
		CLAUDE_PIPELINE_REPO: "kamp-us/phoenix",
		PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
	});

	it("execs the real gh for a passthrough REST call", async () => {
		const {code, stdout} = await run(["api", "repos/kamp-us/phoenix/issues/1"], shimEnv());
		assert.strictEqual(code, 0);
		assert.include(stdout, "FAKE_GH api repos/kamp-us/phoenix/issues/1");
	}, 30_000);

	it("rewrites `gh pr edit` to a REST PATCH before execing the real gh", async () => {
		const {code, stdout, stderr} = await run(["pr", "edit", "42", "--body", "hello"], shimEnv());
		assert.strictEqual(code, 0);
		assert.include(stdout, "FAKE_GH api -X PATCH repos/kamp-us/phoenix/issues/42");
		assert.include(stderr, "routed to REST PATCH");
	}, 30_000);

	it("blocks `gh project` with a non-zero exit and a REST hint", async () => {
		const {code, stderr} = await run(["project", "list"], shimEnv());
		assert.strictEqual(code, 1);
		assert.include(stderr, "blocked");
		assert.include(stderr, "REST");
	}, 30_000);
});
