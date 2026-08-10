/**
 * The end-to-end half: the **exit status and the bytes on each channel** a shell caller reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). Two spawns, both about facts no
 * in-process test can establish: that the group is reachable by its registration alone, and that a
 * refusal really does leave stdout empty across the process boundary. Everything else about these
 * verbs is covered in-process by the `*-verb.unit.test.ts` files beside them.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {EMPTY_STDIN} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the repo root installs. */
const fabrika = (args: ReadonlyArray<string>, stdin = ""): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1"},
			input: stdin,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("fabrika grill, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("lists all five verbs under --help by its registration alone", () => {
		const run = fabrika(["grill", "--help"]);
		expect(run.code).toBe(0);
		for (const verb of ["open", "round", "answer", "rule", "read"]) {
			expect(run.stdout).toContain(verb);
		}
	});

	it("refuses an empty round on its own code with NOTHING on stdout", () => {
		const run = fabrika(["grill", "round", "9412", "--repo", "o/r"], "");
		expect(run.code).toBe(EMPTY_STDIN);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("grill round: stdin was read and held nothing");
	});
});
