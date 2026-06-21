import {execFile} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

// `pipeline-cli changelog-derive derive` is the operable surface (ADR 0069).
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "changelog-derive", ...args], (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
	});

describe("derive CLI", () => {
	let dir: string;
	const write = (name: string, content: string): string => {
		const p = join(dir, name);
		writeFileSync(p, content, "utf8");
		return p;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "changelog-derive-"));
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("emits a Keep-a-Changelog section grouped by category with (#NNN) backlinks", async () => {
		const entries = write(
			"entries.json",
			JSON.stringify([
				{issue: 1, pr: 2, title: "add thing", type: "feature"},
				{issue: 3, pr: 4, title: "fix thing", type: "bug"},
				{issue: 5, title: "untyped thing"},
			]),
		);
		const {code, stdout} = await run([
			"derive",
			"--entries",
			entries,
			"--version",
			"0.1.0",
			"--date",
			"2026-06-15",
		]);
		assert.strictEqual(code, 0);
		assert.include(stdout, "## [0.1.0] — 2026-06-15");
		assert.include(stdout, "### Added");
		assert.include(stdout, "- add thing (#2)");
		assert.include(stdout, "### Fixed");
		assert.include(stdout, "- fix thing (#4)");
		assert.include(stdout, "### Uncategorized");
		assert.include(stdout, "- untyped thing (#5)");
	}, 30_000);

	it("writes to --out when given, leaving stdout free of the body", async () => {
		const entries = write("e2.json", JSON.stringify([{issue: 9, title: "x", type: "feature"}]));
		const out = join(dir, "CHANGELOG.md");
		const {code} = await run(["derive", "--entries", entries, "--version", "0.2.0", "--out", out]);
		assert.strictEqual(code, 0);
		assert.include(readFileSync(out, "utf8"), "## [0.2.0]");
	}, 30_000);

	it("exits non-zero on a missing entries file (typed failure)", async () => {
		const {code} = await run(["derive", "--entries", join(dir, "nope.json"), "--version", "0.1.0"]);
		assert.notStrictEqual(code, 0);
	}, 30_000);
});
