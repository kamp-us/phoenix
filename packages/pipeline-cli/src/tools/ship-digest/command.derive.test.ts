import {execFile} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

// `pipeline-cli ship-digest derive` is the operable surface (#1595).
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "ship-digest", ...args], (error, stdout, stderr) => {
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
		dir = mkdtempSync(join(tmpdir(), "ship-digest-"));
	});
	afterAll(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	it("renders a grouped founder digest product/infra → milestone → type", async () => {
		const entries = write(
			"entries.json",
			JSON.stringify([
				{
					issue: 1,
					pr: 2,
					title: "launch page",
					type: "feature",
					milestone: "Beta",
					area: "product",
				},
				{issue: 3, pr: 4, title: "pipeline bump", type: "chore", area: "infra"},
				{pr: 5, title: "untyped thing", area: "product"},
			]),
		);
		const {code, stdout} = await run([
			"derive",
			"--entries",
			entries,
			"--since",
			"2026-06-01",
			"--until",
			"2026-07-01",
		]);
		assert.strictEqual(code, 0);
		assert.include(stdout, "# Ship digest — 2026-06-01 → 2026-07-01");
		assert.include(stdout, "## Product");
		assert.include(stdout, "### Beta");
		assert.include(stdout, "#### Features");
		assert.include(stdout, "- launch page (#2)");
		assert.include(stdout, "## Infra");
		assert.include(stdout, "- pipeline bump (#4)");
		assert.include(stdout, "### Uncategorized");
		assert.include(stdout, "- untyped thing (#5)");
	}, 30_000);

	it("writes to --out when given, leaving stdout free of the body", async () => {
		const entries = write(
			"e2.json",
			JSON.stringify([{pr: 9, title: "x", type: "feature", area: "product"}]),
		);
		const out = join(dir, "DIGEST.md");
		const {code} = await run([
			"derive",
			"--entries",
			entries,
			"--since",
			"2026-06-01",
			"--out",
			out,
		]);
		assert.strictEqual(code, 0);
		assert.include(readFileSync(out, "utf8"), "# Ship digest —");
	}, 30_000);

	it("exits non-zero on a missing entries file (typed failure)", async () => {
		const {code} = await run([
			"derive",
			"--entries",
			join(dir, "nope.json"),
			"--since",
			"2026-06-01",
		]);
		assert.notStrictEqual(code, 0);
	}, 30_000);
});
