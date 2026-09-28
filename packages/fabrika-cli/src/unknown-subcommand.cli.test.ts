/**
 * The end-to-end half of the unknown-subcommand guard: the **exit status** a caller actually reads.
 *
 * The unit tests cover the resolution, every argv shape against the real tree; only a real process
 * proves the code, and the code is the part that carried the lie — `fabrika triage --help` exited
 * 0. An assertion on stdout alone would have passed against the defect, because the defect printed
 * help. One spawn per outcome: refused, and help left alone.
 *
 * The fixture token is no longer `triage`: that group is registered now, so reusing the reported
 * token would assert the guard against a name that resolves.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * `FABRIKA_SKIP_INFER` pins the invocation to *this* copy: the delegation would otherwise resolve
 * whichever install the enclosing repo root pins, which is not the tree under test.
 */
const fabrika = (...args: ReadonlyArray<string>): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1"},
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {
			code: failure.status ?? -1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
		};
	}
};

describe("the unknown-subcommand guard, through the bin", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("refuses an unknown verb probed with --help: non-zero, refusal on stderr, nothing on stdout", () => {
		const run = fabrika("adr", "bogus", "deeper", "--help");
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain('Unknown subcommand "bogus" for "fabrika adr"');
		expect(run.stdout).toBe("");
	});

	it("leaves a group's help alone: exit 0, help on stdout, an empty stderr", () => {
		const run = fabrika("adr", "--help");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("USAGE");
		expect(run.stderr).toBe("");
	});
});
