/**
 * The end-to-end half: `fabrika ledger` resolves, and so does every one of its six verbs.
 *
 * The reported defect was a group that answered `Unknown subcommand "ledger"` — a fact only a real
 * process can settle, because the unit tests exercise the verbs directly and would pass against a
 * group nobody registered.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

/** `FABRIKA_SKIP_INFER` pins the invocation to *this* copy rather than whatever the root pins. */
const fabrika = (...args: ReadonlyArray<string>) => {
	try {
		return {
			code: 0,
			stdout: execFileSync(process.execPath, [BIN, ...args], {
				encoding: "utf8",
				env: {...process.env, FABRIKA_SKIP_INFER: "1"},
				stdio: ["ignore", "pipe", "pipe"],
			}),
			stderr: "",
		};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("`fabrika ledger` is a registered group", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("resolves rather than answering Unknown subcommand", () => {
		const run = fabrika("ledger");
		expect(run.stderr).not.toMatch(/Unknown subcommand/);
		expect(run.stdout).toContain("USAGE");
	});

	it("lists the group under the root index", () => {
		expect(fabrika("--help").stdout).toMatch(/\bledger\b/);
	});

	it.each([
		["open"],
		["draft"],
		["child"],
		["topology"],
		["write"],
		["supersede"],
	])("`ledger %s --help` exits 0 with its flags on stdout", (verb) => {
		const run = fabrika("ledger", verb, "--help");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("USAGE");
		expect(run.stderr).toBe("");
	});

	it("refuses an unknown verb in the group", () => {
		const run = fabrika("ledger", "bogus");
		expect(run.code).not.toBe(0);
		expect(run.stderr).toMatch(/Unknown subcommand/);
		expect(run.stdout).toBe("");
	});
});
