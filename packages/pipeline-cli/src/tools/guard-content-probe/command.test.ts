import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";
import {NOT_GUARD_TOUCHING_EXIT_CODE} from "./command.ts";

// The stdin/exit contract of `pipeline-cli guard-content-probe classify` over the shared bin. Like
// class-probe (#3786), the empty-stdin exposure is an IO-delivery fact, exercised over the ACTUAL
// bin with real stdin wiring. Two load-bearing invariants: every empty shape stays fail-closed to
// `guard-touching` (exit 0), and the proven-ordinary verdict owns an exit code no failure-to-invoke
// produces, so "the probe never ran" can never read as "this ADR is ordinary" (#4219).
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "guard-content-probe-cmd-"));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const runSh = (cmd: string): RunResult => {
	const r = spawnSync("sh", ["-c", cmd], {cwd: REPO_ROOT, encoding: "utf8"});
	return {code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? ""};
};

const INNER = `node "${BIN}" guard-content-probe classify --path .decisions/9999-x.md`;

// The three empty-stdin shapes the #3786 report verified — an empty pipe (`printf ''`),
// `< /dev/null`, and a closed fd 0 (`<&-`) — all deliver an empty read (zero bytes) to the verb.
// Each must report reason `empty-input`, not the old misleading `unreadable-body` (AC3), while
// staying fail-closed to guard-touching.
const EMPTY_READ_SHAPES: ReadonlyArray<readonly [string, string]> = [
	["printf '' (empty pipe)", `printf '' | ${INNER}`],
	["< /dev/null", `${INNER} < /dev/null`],
	["closed stdin <&-", `${INNER} <&-`],
];

describe("guard-content-probe classify — empty stdin stays §CP, evidence is honest (#3786)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	for (const [name, cmd] of EMPTY_READ_SHAPES) {
		it(`${name}: guard-touching (fail-closed, exit 0) with reason [empty-input]`, () => {
			const {code, stdout, stderr} = runSh(cmd);
			expect(stdout.trim()).toBe("guard-touching");
			expect(code).toBe(0);
			expect(stderr).toContain("[empty-input]");
			// The old misleading evidence is gone — a blank body no longer reads as unreadable head.
			expect(stderr).not.toContain("[unreadable-body]");
		});
	}

	it("a guard-relaxing body still classifies guard-touching via a content hit (non-regression)", () => {
		const body = "This decision relaxes the fail-closed enforcement guard.";
		const {code, stdout, stderr} = runSh(`printf '%s\\n' "${body}" | ${INNER}`);
		expect(stdout.trim()).toBe("guard-touching");
		expect(code).toBe(0);
		expect(stderr).toContain("[guard-vocabulary-match]");
	});

	it("an ordinary product ADR classifies not-guard-touching on the verdict code (non-regression)", () => {
		const body = "Term pages sort entries by score, newest first.";
		const {code, stdout} = runSh(`printf '%s\\n' "${body}" | ${INNER}`);
		expect(stdout.trim()).toBe("not-guard-touching");
		expect(code).toBe(NOT_GUARD_TOUCHING_EXIT_CODE);
	});
});

// The property under dispute in #4219: is a FAILURE TO INVOKE distinguishable from the
// proven-ordinary verdict? Only if the verdict owns an exit code no failure-to-run produces — and
// only if the caller asserts on the stdout state word. Both are pinned here, mirroring cp-classify's
// suite (#4161), so the verdict code cannot silently drift back onto the runner's failure code.
const ORDINARY_BODY = join(DIR, "ordinary.md");
writeFileSync(ORDINARY_BODY, "Term pages sort entries by score, newest first.\n");
const ORDINARY = `node "${BIN}" guard-content-probe classify --body-file "${ORDINARY_BODY}" --path .decisions/9999-x.md`;
const BAD_FLAG = `${ORDINARY} --bogus-flag x`;
const TYPO_SUBCOMMAND = `node "${BIN}" guard-content-probe clasify --body-file "${ORDINARY_BODY}"`;
const MISSING_BIN = "guard-content-probe-no-such-binary classify";
const MODULE_NOT_FOUND = `node packages/pipeline-cli/src/bin.ts guard-content-probe classify --body-file "${ORDINARY_BODY}"`;

describe("guard-content-probe classify — the exit contract (#4219)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("the proven-ordinary exit code collides with neither a usage error nor a missing binary", () => {
		expect(NOT_GUARD_TOUCHING_EXIT_CODE).not.toBe(0);
		expect(NOT_GUARD_TOUCHING_EXIT_CODE).not.toBe(1);
		expect(NOT_GUARD_TOUCHING_EXIT_CODE).not.toBe(127);
	});

	it("a bad flag is an invocation failure: no state word on stdout, and not the verdict code", () => {
		const r = runSh(BAD_FLAG);
		expect(r.stdout).not.toContain("not-guard-touching");
		expect(r.code).not.toBe(NOT_GUARD_TOUCHING_EXIT_CODE);
		expect(r.code).not.toBe(0);
	});

	it("a typo'd subcommand is an invocation failure: not the verdict code", () => {
		const r = runSh(TYPO_SUBCOMMAND);
		expect(r.stdout).not.toContain("not-guard-touching");
		expect(r.code).not.toBe(NOT_GUARD_TOUCHING_EXIT_CODE);
		expect(r.code).not.toBe(0);
	});

	it("a missing binary is an invocation failure: exit 127, empty stdout", () => {
		const r = runSh(MISSING_BIN);
		expect(r.code).toBe(127);
		expect(r.stdout.trim()).toBe("");
		expect(r.code).not.toBe(NOT_GUARD_TOUCHING_EXIT_CODE);
	});

	// The nested-cwd trigger the call sites actually hit: `node packages/pipeline-cli/src/bin.ts` is
	// cwd-relative, and sessions in this repo launch in a nested app directory by convention.
	it("a module-not-found from a nested cwd is an invocation failure: not the verdict code", () => {
		const r = spawnSync("sh", ["-c", MODULE_NOT_FOUND], {
			cwd: join(REPO_ROOT, "apps", "web"),
			encoding: "utf8",
		});
		expect(r.stdout ?? "").not.toContain("not-guard-touching");
		expect(r.status ?? 0).not.toBe(NOT_GUARD_TOUCHING_EXIT_CODE);
		expect(r.status ?? 0).not.toBe(0);
	});
});

describe("guard-content-probe classify — the caller idiom (#4219)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	// The sanctioned shape all six gate call sites now use: a POSITIVE match on the stdout state
	// word, with every other value — including the empty string a failure to invoke leaves — routed
	// to BLOCKING. Proven-ordinary, proven-guard, and could-not-determine stay three distinct
	// outcomes; only the first may skip the §CP hold.
	const stateWordIdiom = (inner: string): RunResult =>
		runSh(
			`GC_STATE="$(${inner} 2>/dev/null)"; case "$GC_STATE" in not-guard-touching) echo ordinary ;; guard-touching) echo BLOCKING-guard ;; *) echo BLOCKING-undetermined ;; esac`,
		);

	const GUARDY = join(DIR, "guardy.md");
	writeFileSync(GUARDY, "This decision relaxes the fail-closed enforcement guard.\n");
	const GUARD = `node "${BIN}" guard-content-probe classify --body-file "${GUARDY}" --path .decisions/9999-x.md`;

	it("proven ordinary → ordinary", () => {
		expect(stateWordIdiom(ORDINARY).stdout.trim()).toBe("ordinary");
	});

	it("proven guard-touching → BLOCKING-guard", () => {
		expect(stateWordIdiom(GUARD).stdout.trim()).toBe("BLOCKING-guard");
	});

	for (const [name, inner] of [
		["a bad flag", BAD_FLAG],
		["a typo'd subcommand", TYPO_SUBCOMMAND],
		["a missing binary", MISSING_BIN],
	] as const) {
		it(`${name} → BLOCKING-undetermined (never ordinary)`, () => {
			expect(stateWordIdiom(inner).stdout.trim()).toBe("BLOCKING-undetermined");
		});
	}

	// Why the old published shape was fail-OPEN: `&& echo BLOCKING` emits nothing when the verb never
	// ran, so the ADR is recorded as ordinary. Pinned so nobody "simplifies" a call site back onto it.
	it("the old `>/dev/null && echo BLOCKING` shape fails OPEN on a failure to invoke", () => {
		expect(runSh(`${MISSING_BIN} 2>/dev/null && echo BLOCKING`).stdout.trim()).toBe("");
		expect(runSh(`${BAD_FLAG} >/dev/null 2>&1 && echo BLOCKING`).stdout.trim()).toBe("");
	});
});
