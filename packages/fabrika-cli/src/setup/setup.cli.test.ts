/**
 * The one thing only a real process can prove about `fabrika setup`: it finishes with no terminal
 * to read from. One spawn, and it never reaches the network — the directory is no git repository
 * and names no target repo, so the first label step refuses before any request.
 */
import {spawnSync} from "node:child_process";
import {existsSync, mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {FAILED} from "../verb.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

describe("fabrika setup with stdin closed", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("finishes without reading the terminal, stopping at the step that cannot run", () => {
		const cwd = mkdtempSync(join(tmpdir(), "fabrika-setup-"));
		const {CLAUDE_PIPELINE_REPO: _pipeline, GITHUB_REPOSITORY: _repository, ...env} = process.env;
		const run = spawnSync(process.execPath, [BIN, "setup"], {
			cwd,
			encoding: "utf8",
			// `FABRIKA_SKIP_INFER` pins the run to this copy of the CLI.
			env: {...env, FABRIKA_SKIP_INFER: "1"},
			stdio: ["ignore", "pipe", "pipe"],
		});

		expect(run.status).toBe(FAILED);
		expect(run.stdout).toBe("bootstrap\tcreated\tsettings-patch\t.claude/settings.json\tok\n");
		expect(run.stderr).toContain("status bootstrap: cannot resolve a target repo");
		expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(true);
		expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
	});
});
