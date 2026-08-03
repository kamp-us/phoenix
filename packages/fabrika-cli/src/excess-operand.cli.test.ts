/**
 * The end-to-end half of the excess-operand guard: the **exit status** a caller actually reads.
 *
 * The defect this covers produced a successful-looking result — exit 0 with the id `adr next` would
 * have printed anyway (#4828) — so a test asserting on stdout *content* is exactly the test that
 * passes against the bug. Every case below asserts the exit code and stderr instead.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

/** Spawning under a loaded machine outruns vitest's 5s default (the #4014 false red). */
const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

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

const scratchDir = (): string => mkdtempSync(join(tmpdir(), "fabrika-4828-"));

/** `1` is the interface convention's usage-error code (§3), and what the refusal must seat on. */
const USAGE_ERROR = 1;

describe("an operand no leaf verb declares is refused", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("refuses one excess operand on a verb that declares none", () => {
		const run = fabrika("adr", "next", "extratoken");
		expect(run.code).toBe(USAGE_ERROR);
		expect(run.stderr).toContain('unexpected operand "extratoken"');
		expect(run.stdout).toBe("");
	});

	it("refuses more than one excess operand, naming each", () => {
		const run = fabrika("adr", "next", "a", "b");
		expect(run.code).toBe(USAGE_ERROR);
		expect(run.stderr).toContain('unexpected operands "a", "b"');
		expect(run.stdout).toBe("");
	});

	it("refuses an excess operand that follows a flag", () => {
		const run = fabrika("adr", "next", "--json", "extratoken");
		expect(run.code).toBe(USAGE_ERROR);
		expect(run.stderr).toContain('unexpected operand "extratoken"');
		expect(run.stdout).toBe("");
	});

	it("refuses an operand beyond a fixed arity, and writes nothing", () => {
		const dir = scratchDir();
		const run = fabrika("adr", "new", "0240", "some-slug", "extra", "--dir", dir);
		expect(run.code).toBe(USAGE_ERROR);
		expect(run.stderr).toContain('unexpected operand "extra"');
		expect(run.stdout).toBe("");
	});

	it("refuses in a group other than adr, so the guard is not one verb's", () => {
		const run = fabrika("eval", "check", "some-manifest.json", "extra");
		expect(run.code).toBe(USAGE_ERROR);
		expect(run.stderr).toContain('unexpected operand "extra"');
	});

	it("names the full verb path, not just the token", () => {
		expect(fabrika("adr", "next", "extratoken").stderr).toContain('for "fabrika adr next"');
	});
});

describe("what already worked still works", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("a variadic verb absorbs its operands rather than refusing them", () => {
		const run = fabrika("adr", "resolve", "0164", "0023", "--dir", scratchDir());
		expect(run.stderr).not.toContain("unexpected operand");
	});

	it("a fixed-arity verb at its declared arity still succeeds", () => {
		const run = fabrika("adr", "new", "0240", "some-slug", "--dir", scratchDir());
		expect(run.code).toBe(0);
		expect(run.stdout).not.toBe("");
	});

	it.each([
		["the root index", ["--help"]],
		["a group's verbs", ["adr", "--help"]],
		["a verb's flags", ["adr", "next", "--help"]],
	])("%s still exits 0 with help on stdout and an empty stderr", (_label, args) => {
		const run = fabrika(...args);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("USAGE");
		expect(run.stderr).toBe("");
	});

	it("the catch-all stays out of the help a caller reads — help is the interface", () => {
		expect(fabrika("adr", "next", "--help").stdout).not.toContain("excess");
	});
});
