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

// A valid SKILL.md — a quoted `description:` scalar so both the gh-call scan and the
// frontmatter check have non-empty scope and neither flags it. The CI corpus always holds
// such files; the unit CLI cases must too, else the frontmatter zero-scope fires.
const VALID_SKILL = [
	"---",
	"name: sample",
	'description: "a sample skill: it does a thing without tripping the gate"',
	"---",
	"",
	"use gh api repos/o/r/issues/1",
].join("\n");

// A SKILL.md with a valid frontmatter but a GraphQL-path gh call in its body.
const SKILL_WITH_GH_CALL = [
	"---",
	"name: sample",
	'description: "a sample skill"',
	"---",
	"",
	"step one",
	"run gh project list",
].join("\n");

// The #1766 trigger at the CLI boundary: unquoted description with a mid-sentence colon-space.
const SKILL_BROKEN_FRONTMATTER = [
	"---",
	"name: sample",
	"description: run the five-step ritual: pre-flight the flag and flip it live",
	"---",
	"",
	"# sample",
].join("\n");

describe("lint-skills CLI — fail-closed exit contract (ADR 0092)", () => {
	let dir: string;
	// Write under a `skills/<name>/SKILL.md` path so the frontmatter check scopes it.
	const writeSkill = (name: string, content: string): string => {
		const d = join(dir, "skills", name);
		mkdirSync(d, {recursive: true});
		const p = join(d, "SKILL.md");
		writeFileSync(p, content, "utf8");
		return p;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "gh-phoenix-lint-"));
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("exits 3 (zero-scope FAIL) when every handed file is gh-grep self-exempt", async () => {
		// write-code/SKILL.md is self-exempt from the gh-grep → gh-scan scope empty → fail-closed.
		// Its frontmatter is valid, so the FAIL is on the empty gh-call scope, not frontmatter.
		mkdirSync(join(dir, "skills", "write-code"), {recursive: true});
		const f = join(dir, "skills", "write-code", "SKILL.md");
		writeFileSync(f, VALID_SKILL, "utf8");
		const {code, stderr} = await run(["lint-skills", f]);
		assert.strictEqual(code, 3);
		assert.include(stderr, "zero");
	}, 30_000);

	it("exits 2 and reports the finding on a GraphQL-path gh call", async () => {
		const f = writeSkill("dirty", SKILL_WITH_GH_CALL);
		const {code, stderr, stdout} = await run(["lint-skills", f]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "gh project");
		assert.include(stdout, "scanned 1 file");
	}, 30_000);

	it("exits 2 and reports the finding on invalid YAML frontmatter (#1766)", async () => {
		const f = writeSkill("broken-fm", SKILL_BROKEN_FRONTMATTER);
		const {code, stderr, stdout} = await run(["lint-skills", f]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "invalid YAML frontmatter");
		assert.include(stdout, "frontmatter check scanned 1 file");
	}, 30_000);

	it("exits 0 and emits both checks' scope on a clean skill file", async () => {
		const f = writeSkill("clean", VALID_SKILL);
		const {code, stdout} = await run(["lint-skills", f]);
		assert.strictEqual(code, 0);
		assert.include(stdout, "gh-call scan scanned 1 file");
		assert.include(stdout, "frontmatter check scanned 1 file");
		assert.include(stdout, "clean");
	}, 30_000);

	it("exits 3 (zero-scope FAIL) when every file is unreadable/missing", async () => {
		const {code, stderr} = await run(["lint-skills", join(dir, "does-not-exist.md")]);
		assert.strictEqual(code, 3);
		assert.include(stderr, "zero");
	}, 30_000);
});
