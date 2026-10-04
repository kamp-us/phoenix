/**
 * The end-to-end half: the **exit status and the bytes on each channel** a shell caller reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). Two spawns, both about facts no
 * in-process test can establish: an `open` refusal the adapter makes before any verb runs, and a
 * genuinely empty pipe on fd 0 reaching a verb as read-and-empty rather than as a failed read. The
 * empty-pipe spawn stands for every group that takes a body on stdin through the shared reader.
 * Registration is in `command.unit.test.ts`; the verbs are covered in-process beside them.
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
	// The refusal moved to the adapter when `OpenSubject` made "neither flag" unrepresentable in the
	// verb, so this is the only tier that still reaches it.
	it("refuses grill open with neither --topic nor --ticket, touching no network", () => {
		const run = fabrika(["grill", "open", "--repo", "o/r"]);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("neither --topic nor --ticket");
	});

	it("refuses an empty round on its own code with NOTHING on stdout", () => {
		const run = fabrika(["grill", "round", "9412", "--repo", "o/r"], "");
		expect(run.code).toBe(EMPTY_STDIN);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("grill round: stdin was read and held nothing");
	});
});
