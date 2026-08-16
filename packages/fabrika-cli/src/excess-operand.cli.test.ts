// @patch-pin: effect@4.0.0-beta.92
/**
 * The end-to-end half of the excess-operand guard: the **exit status** a caller actually reads.
 *
 * Also the registered behavior pin for the `effect` patch's hunk 3 (`buildHelpDoc` honouring
 * `Param.withHidden` on a positional): the help case below fails if upstream's unpatched
 * rendering comes back. It took the pin over when ADR 0279 removed the crew package that
 * carried it.
 *
 * The defect this covers produced a successful-looking result — exit 0 with the id `adr next` would
 * have printed anyway (#4828) — so a test asserting on stdout *content* is exactly the test that
 * passes against the bug. Every case below asserts the exit code and stderr instead.
 *
 * **Five spawns, and none of them touch the network (#4847).** Each `it` costs one cold node+TS load
 * of `bin.ts` — about 2.3s on a CI runner — so spawn count *is* this file's cost, and the matrix it
 * used to walk twelve times is covered in 19ms by `excess-operand.unit.test.ts`. What only a
 * subprocess can prove is the exit status, which needs a handful of representative invocations, not
 * one per phrasing. Twelve spawns plus one that fetched `origin/main` for real is what timed out and
 * ejected PR #4835 from the merge queue; the cwd that removes that fetch is explained at its case.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {BASE_UNFETCHABLE} from "./adr/codes.ts";
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
const fabrika = (args: ReadonlyArray<string>, cwd: string = process.cwd()): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			cwd,
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
	it("refuses an excess operand, naming both the token and the verb path", () => {
		const run = fabrika(["adr", "next", "extratoken"]);
		expect(run.code).toBe(USAGE_ERROR);
		expect(run.stderr).toContain('unexpected operand "extratoken"');
		expect(run.stderr).toContain('for "fabrika adr next"');
		expect(run.stdout).toBe("");
	});

	// The operand trails a flag *and* a satisfied arity, which is the shape a pre-runner argv walk
	// gets wrong: only the parser knows `extra` is a positional rather than another `--dir` value.
	it("refuses an operand past a fixed arity that follows a flag, and writes nothing", () => {
		const dir = scratchDir();
		const run = fabrika(["adr", "new", "0240", "some-slug", "--dir", dir, "extra"]);
		expect(run.code).toBe(USAGE_ERROR);
		expect(run.stderr).toContain('unexpected operand "extra"');
		expect(run.stdout).toBe("");
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("what already worked still works", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	/**
	 * `adr resolve` is the one variadic leaf, so it is the one verb whose own arguments must swallow
	 * the operands before the catch-all sees them. It is also the one verb here that does real work:
	 * inside this repo it fetches `origin/main` before reading it, which cost 15.4s green and 41.3s
	 * under merge-queue contention. From a cwd that is not a git repository it refuses at that first
	 * git read instead, and the assertion is unweakened — the excess-operand check runs at parse
	 * time, before the verb reaches git, so a regressed catch-all still seats `USAGE_ERROR` here.
	 * `--repo` is what keeps the refusal on `BASE_UNFETCHABLE` rather than the ambiguous `1` the
	 * origin-remote lookup would return, so the code alone separates "ran" from "refused".
	 */
	it("a variadic verb absorbs its operands rather than refusing them", () => {
		const run = fabrika(["adr", "resolve", "0164", "0023", "--repo", "owner/name"], scratchDir());
		expect(run.stderr).not.toContain("unexpected operand");
		expect(run.code).toBe(BASE_UNFETCHABLE);
	});

	it("a fixed-arity verb at its declared arity still succeeds", () => {
		const run = fabrika(["adr", "new", "0240", "some-slug", "--dir", scratchDir()]);
		expect(run.code).toBe(0);
		expect(run.stdout).not.toBe("");
	});

	// That help at every depth still exits 0 with USAGE is asserted four ways in
	// `unknown-subcommand.cli.test.ts`; the half only this file owns is that the hidden catch-all
	// stays out of it — help is the interface, and it must not offer an argument that does not exist.
	it("a verb's help exits 0 and never advertises the catch-all", () => {
		const run = fabrika(["adr", "next", "--help"]);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("USAGE");
		expect(run.stderr).toBe("");
		expect(run.stdout).not.toContain("excess");
	});
});
