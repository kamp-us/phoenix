import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";
import {NOT_CONTROL_PLANE_EXIT_CODE} from "./command.ts";

// The exit/stdout contract of `pipeline-cli cp-classify classify`, over the REAL bin. The one
// property under dispute in review of #4161 was the one with no test: whether a FAILURE TO INVOKE
// is distinguishable from the `not-control-plane` verdict. It is only distinguishable if the
// verdict owns an exit code no failure-to-run produces, and only asserted safely on the stdout
// state word — both pinned here, alongside the four classifier states.
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const BOUNDARY = "^(\\.github|\\.claude)/";

const DIR = mkdtempSync(join(tmpdir(), "cp-classify-cmd-"));

/** A changed-file list on disk — `--files-file` keeps the probe off stdin and out of a pipe. */
const fileList = (name: string, paths: ReadonlyArray<string>): string => {
	const p = join(DIR, name);
	writeFileSync(p, `${paths.join("\n")}\n`);
	return p;
};

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Run a shell fragment and report the status of the LAST command in it. Every probe below is
 * pipe-free on purpose: `pipefail` is off by default, so a bare pipe reports the tail's status and
 * would mask the exact invocation failures this suite exists to observe.
 */
const runSh = (cmd: string): RunResult => {
	const r = spawnSync("sh", ["-c", cmd], {cwd: REPO_ROOT, encoding: "utf8"});
	return {code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? ""};
};

const classify = (args: string): RunResult =>
	runSh(`node "${BIN}" cp-classify classify --control-plane-re '${BOUNDARY}' ${args}`);

describe("cp-classify classify — the exit contract (#4161)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	const STATES: ReadonlyArray<readonly [string, ReadonlyArray<string>, number]> = [
		["control-plane", [".github/workflows/ci.yml"], 0],
		["content-undetermined", [".decisions/0217-lane-claim-authority.md"], 0],
		["unknown", [], 0],
		["not-control-plane", ["apps/web/src/routes/home.tsx"], NOT_CONTROL_PLANE_EXIT_CODE],
	];

	for (const [state, paths, code] of STATES) {
		it(`${state} → stdout '${state}', exit ${code}`, () => {
			const r = classify(`--files-file "${fileList(`${state}.txt`, paths)}"`);
			expect(r.stdout.trim()).toBe(state);
			expect(r.code).toBe(code);
		});
	}

	// The whole point of reseating the verdict off exit 1: 1 is effect-cli's usage-error code and
	// 127 is the shell's missing-binary code, so a verdict seated on either is unreadable as proof.
	it("the proven-ordinary exit code collides with neither a usage error nor a missing binary", () => {
		expect(NOT_CONTROL_PLANE_EXIT_CODE).not.toBe(0);
		expect(NOT_CONTROL_PLANE_EXIT_CODE).not.toBe(1);
		expect(NOT_CONTROL_PLANE_EXIT_CODE).not.toBe(127);
	});

	it("a bad flag is an invocation failure: no state word on stdout, and not the verdict code", () => {
		const r = classify("--bogus-flag x");
		expect(r.stdout).not.toContain("not-control-plane");
		expect(r.code).not.toBe(NOT_CONTROL_PLANE_EXIT_CODE);
		expect(r.code).not.toBe(0);
	});

	it("a missing binary is an invocation failure: exit 127, empty stdout", () => {
		const r = runSh("cp-classify-no-such-binary classify");
		expect(r.code).toBe(127);
		expect(r.stdout.trim()).toBe("");
		expect(r.code).not.toBe(NOT_CONTROL_PLANE_EXIT_CODE);
	});
});

describe("cp-classify classify — the caller idiom (#4161)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	// The sanctioned shape the register publishes and all three rewired gates use: a POSITIVE match
	// on the stdout state word. It must hold on a real ordinary verdict and refuse on every
	// failure-to-invoke — which is exactly what the two naive exit-status shapes get wrong.
	const stateWordIdiom = (inner: string): RunResult =>
		runSh(
			`CP_STATE="$(${inner} 2>/dev/null)"; if [ "$CP_STATE" = "not-control-plane" ]; then echo ordinary; else echo BLOCKING; fi`,
		);

	const ORDINARY = `node "${BIN}" cp-classify classify --control-plane-re '${BOUNDARY}' --files-file "${fileList("idiom-ordinary.txt", ["apps/web/src/a.tsx"])}"`;
	const CP = `node "${BIN}" cp-classify classify --control-plane-re '${BOUNDARY}' --files-file "${fileList("idiom-cp.txt", [".claude/settings.json"])}"`;
	const BAD_FLAG = `${ORDINARY} --bogus-flag x`;
	const MISSING_BIN = "cp-classify-no-such-binary classify";

	it("proven ordinary → ordinary", () => {
		expect(stateWordIdiom(ORDINARY).stdout.trim()).toBe("ordinary");
	});

	for (const [name, inner] of [
		["control-plane", CP],
		["a bad flag", BAD_FLAG],
		["a missing binary", MISSING_BIN],
	] as const) {
		it(`${name} → BLOCKING`, () => {
			expect(stateWordIdiom(inner).stdout.trim()).toBe("BLOCKING");
		});
	}

	// Why the register names `… || ordinary` UNSAFE: it reads any non-zero as the verdict, so a
	// failure to invoke routes to the ordinary branch. Pinned so the doc's claim stays grounded in
	// observed behavior rather than intuition, and so nobody "simplifies" a call site back onto it.
	it("the naive `|| ordinary` shape fails OPEN on a failure to invoke", () => {
		expect(runSh(`${MISSING_BIN} 2>/dev/null || echo ordinary`).stdout.trim()).toBe("ordinary");
		expect(runSh(`${BAD_FLAG} >/dev/null 2>&1 || echo ordinary`).stdout.trim()).toBe("ordinary");
	});

	it("the naive `&& echo BLOCKING` shape fails OPEN on a failure to invoke — it emits nothing", () => {
		expect(runSh(`${MISSING_BIN} 2>/dev/null && echo BLOCKING`).stdout.trim()).toBe("");
		expect(runSh(`${BAD_FLAG} >/dev/null 2>&1 && echo BLOCKING`).stdout.trim()).toBe("");
	});
});
