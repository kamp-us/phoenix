import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {BAD_INVOCATION_EXIT_CODE} from "../../exit-codes.ts";
import {STDIN_READ_FAILED_EXIT_CODE} from "../../read-stdin.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";

// The exit-code contract of `cp-cardinality decide` over the REAL bin, because the defect lives in
// the invocation boundary the pure core never sees: `--pr`/`--head` (flags this verb never accepted)
// exited 1, which is also its `stop` verdict, so a caller recorded "no approval at current head" for
// four §CP PRs whose decision never ran (#5072).
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

const ROSTER = "usirin\\nnotusirin\\n";

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const decide = (flags: string, roster: string = ROSTER): RunResult => {
	const r = spawnSync(
		"sh",
		["-c", `printf '${roster}' | node "${BIN}" cp-cardinality decide ${flags}`],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
		},
	);
	return {code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? ""};
};

describe("cp-cardinality decide — a bad invocation is not a verdict (#5072)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("exits on the bad-invocation code for the flags the field call invented, not on `stop`", () => {
		const {code, stdout} = decide("--pr 5051 --head deadbeef --author usirin");
		expect(code).toBe(BAD_INVOCATION_EXIT_CODE);
		// The whole defect: 1 IS this verb's `stop`. A caller reading either code off a verdict table
		// would transcribe a refused invocation as a definite "no approval at current head".
		expect(code).not.toBe(0);
		expect(code).not.toBe(1);
		// The decision word is a line of its own on stdout; the help text this failure prints merely
		// mentions "discharge" in prose, so match the line, not the substring.
		const lines = stdout.split("\n").map((l) => l.trim());
		expect(lines).not.toContain("stop");
		expect(lines).not.toContain("discharge");
	});

	it("names the unrecognized flags, so the failure is diagnosable without re-running", () => {
		const {stdout, stderr} = decide("--pr 5051 --author usirin");
		expect(`${stdout}${stderr}`).toContain("--pr");
	});

	it("keeps the never-ran band one number — the same code an unread stdin already used", () => {
		expect(BAD_INVOCATION_EXIT_CODE).toBe(STDIN_READ_FAILED_EXIT_CODE);
	});
});

describe("cp-cardinality decide — the verdict codes are untouched", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("discharges on exit 0 with a non-author current-head approval (N>=2)", () => {
		const {code, stdout} = decide("--author usirin --non-author-approval-at-head");
		expect(stdout.trim()).toBe("discharge");
		expect(code).toBe(0);
	});

	it("stops on exit 1 with no signal (N>=2)", () => {
		const {code, stdout} = decide("--author usirin");
		expect(stdout.trim()).toBe("stop");
		expect(code).toBe(1);
	});
});
