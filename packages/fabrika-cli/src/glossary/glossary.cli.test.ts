/**
 * The end-to-end half: the **exit status and the bytes on each channel** a shell caller reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). Three spawns, each about a fact
 * no in-process test can establish: that the group is reachable by its registration alone, that a
 * refusal really does leave stdout empty across the process boundary, and that the answer channel
 * carries the answer and nothing else. Everything else about these verbs is covered in-process by
 * the `*-verb.unit.test.ts` files and by `contract-examples.test.ts`.
 */
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {ZERO_SCOPE} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const REGISTERS = "packages/fabrika-cli/test-fixtures/glossary/registers";

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the repo root installs.
 *
 * `spawnSync` rather than `execFileSync`: the channel split is what these tests are about, and
 * `execFileSync` hands back stderr only on the throwing path — so an assertion about stderr on a
 * successful run would be asserting against a string the helper made up.
 */
const fabrika = (args: ReadonlyArray<string>, stdin = ""): Run => {
	const run = spawnSync(process.execPath, [BIN, ...args], {
		encoding: "utf8",
		env: {...process.env, FABRIKA_SKIP_INFER: "1"},
		input: stdin,
	});
	return {code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? ""};
};

describe("fabrika glossary, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("lists all six verbs under --help by its registration alone", () => {
		const run = fabrika(["glossary", "--help"]);
		expect(run.code).toBe(0);
		for (const verb of ["init", "drift", "lookup", "sections", "add", "check"]) {
			expect(run.stdout).toContain(verb);
		}
	});

	it("puts the answer on stdout and the scope line on stderr", () => {
		const run = fabrika(["glossary", "lookup", "tag", "--register", "terms", "--dir", REGISTERS]);
		expect(run.code).toBe(0);
		expect(run.stdout).toBe("collision\tterms\tIndexing\tDatabase (tag)\n");
		expect(run.stderr).toContain("6 row(s)");
	});

	it("refuses a pathspec that matched nothing on its own code, with NOTHING on stdout", () => {
		const run = fabrika(["glossary", "drift", "--paths", "no/such/dir"]);
		expect(run.code).toBe(ZERO_SCOPE);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("matched 0 tracked files");
	});
});
