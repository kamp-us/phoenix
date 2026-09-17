/**
 * The exactly-one-flag fence on `decision rule`, at the only tier that reaches it.
 *
 * The verb takes one `RulingSource`, so "neither flag" and "both flags" are unrepresentable below
 * the adapter: `./rule-verb.unit.test.ts` constructs the source directly and can never produce
 * either. The refusal lives in `./command.ts`'s `rulingSource`, which a real invocation is the only
 * way to reach — hence a subprocess, and hence this file.
 *
 * Each `it` costs one cold node+TS load of `bin.ts`, so spawn count is the cost
 * (`.patterns/subprocess-test-budget.md`). Two spawns, one per arm, and both assert the same three
 * facts a caller reads: status `1`, nothing on stdout, and the refusal named on stderr. Nothing is
 * written because nothing is reached — the refusal is above `runRule`, so no token is read and no
 * request is made.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8857#issuecomment-5625302485
 */

import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the repo root installs. */
const fabrika = (args: ReadonlyArray<string>): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1"},
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("fabrika decision rule — exactly one flag", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("refuses with neither --cites nor --authorization, writing nothing", () => {
		const run = fabrika(["decision", "rule", "9412", "--repo", "o/r"]);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("decision rule: pass exactly one of --cites");
		expect(run.stderr).toContain("nothing was written");
	});

	// Neither flag's value is well-formed, and neither is looked at: the ambiguity is refused above
	// the URL check and above the file read, which is the point of refusing it at the adapter.
	it("refuses with both --cites and --authorization, writing nothing", () => {
		const run = fabrika([
			"decision",
			"rule",
			"9412",
			"--repo",
			"o/r",
			"--cites",
			"a-comment-url",
			"--authorization",
			"ruling.md",
		]);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("decision rule: pass exactly one of --cites");
		expect(run.stderr).toContain("nothing was written");
	});
});
