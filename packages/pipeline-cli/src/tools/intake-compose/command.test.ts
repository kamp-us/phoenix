import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

// The exit + stdout contract of `pipeline-cli intake-compose sub-issue` over the shared bin.
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>, input?: string): RunResult => {
	const r = spawnSync("node", [BIN, "intake-compose", ...args], {
		encoding: "utf8",
		input: input ?? "",
	});
	return {code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? ""};
};

const validSpec = {
	stories: "4, 9",
	tdd: "yes",
	containment: "exempt (internal pipeline tooling — no user-facing surface)",
	whatToBuild: "Add a pipeline-cli intake composer verb.",
	acceptanceCriteria: ["A verb emits a format-2 body.", "Consumers cite the verb."],
};

describe("intake-compose sub-issue — leak-safe stdout handoff (AC3)", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "intake-compose-"));
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("emits the composed format-2 body to stdout and exits 0 (spec from a file)", () => {
		const f = join(dir, "spec.json");
		writeFileSync(f, JSON.stringify(validSpec), "utf8");
		const {code, stdout} = run(["sub-issue", "--spec", f]);
		assert.strictEqual(code, 0);
		assert.include(stdout, "**Stories:** 4, 9");
		assert.include(stdout, "**TDD:** yes");
		assert.include(stdout, "### What to build");
		assert.include(stdout, "### Acceptance criteria");
		assert.include(stdout, "- [ ] A verb emits a format-2 body.");
	}, 30_000);

	it("reads the spec from stdin when --spec is omitted", () => {
		const {code, stdout} = run(["sub-issue"], JSON.stringify(validSpec));
		assert.strictEqual(code, 0);
		assert.include(stdout, "### Acceptance criteria");
	}, 30_000);

	// The whole point: the body is emitted BY VALUE to stdout, so a caller passes it
	// as `-f body="$BODY"` — no file path is ever handed back to `@`-reference.
	it("the emitted body carries no machine-local filesystem path (no @file leak surface)", () => {
		const f = join(dir, "spec2.json");
		writeFileSync(f, JSON.stringify(validSpec), "utf8");
		const {stdout} = run(["sub-issue", "--spec", f]);
		assert.notMatch(stdout, /(^|\s)@[/~]/);
		// The spec file path itself must not appear in the emitted body.
		assert.notInclude(stdout, f);
	}, 30_000);

	it("exits 2 on zero acceptance criteria (the format-2 hard floor)", () => {
		const f = join(dir, "no-ac.json");
		writeFileSync(f, JSON.stringify({...validSpec, acceptanceCriteria: []}), "utf8");
		const {code, stderr} = run(["sub-issue", "--spec", f]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "acceptance criterion");
	}, 30_000);

	it("exits 2 on malformed JSON", () => {
		const f = join(dir, "bad.json");
		writeFileSync(f, "{not json", "utf8");
		const {code, stderr} = run(["sub-issue", "--spec", f]);
		assert.strictEqual(code, 2);
		assert.include(stderr, "valid JSON");
	}, 30_000);
});
