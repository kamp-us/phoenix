/**
 * The end-to-end half of the unknown-subcommand guard: the **exit status** a caller actually reads.
 *
 * The unit tests cover the resolution; only a real process proves the code, and the code is the part
 * that carried the lie — `fabrika triage --help` exited 0 (#4822). An assertion on stdout alone would
 * have passed against the defect, because the defect printed help.
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

describe("an unresolvable path is refused, at every depth", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it.each([
		["an unknown group", ["nosuchgroup"]],
		["an unknown group probed with --help", ["nosuchgroup", "--help"]],
		["an unknown group probed with -h", ["nosuchgroup", "-h"]],
		["an unknown verb in a known group", ["adr", "bogus"]],
		["an unknown verb probed with --help", ["adr", "bogus", "--help"]],
		["a multi-token invalid tail probed with --help", ["adr", "bogus", "deeper", "--help"]],
	])("%s exits non-zero with the refusal on stderr and nothing on stdout", (_label, args) => {
		const run = fabrika(...args);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toMatch(/Unknown subcommand/);
		expect(run.stdout).toBe("");
	});

	it("names the group a bad verb sat under, not just the root", () => {
		expect(fabrika("adr", "bogus", "deeper", "--help").stderr).toContain('for "fabrika adr"');
	});

	it("reports the first invalid token, not a later one", () => {
		expect(fabrika("adr", "bogus", "deeper", "--help").stderr).toContain('"bogus"');
	});
});

describe("the discovery path is unchanged", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it.each([
		["the root index", ["--help"]],
		["a group's verbs", ["adr", "--help"]],
		["a verb's flags", ["adr", "next", "--help"]],
		["a verb's flags behind another flag", ["adr", "next", "--dir", ".decisions", "--help"]],
	])("%s still exits 0 with help on stdout and an empty stderr", (_label, args) => {
		const run = fabrika(...args);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("USAGE");
		expect(run.stderr).toBe("");
	});
});
