import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

// The stdin/exit contract of `pipeline-cli guard-content-probe classify` over the shared bin. Like
// class-probe (#3786), the empty-stdin exposure is an IO-delivery fact, exercised over the ACTUAL
// bin with real stdin wiring. The load-bearing invariant: every empty shape stays fail-closed to
// `guard-touching` (exit 0) — only the reason EVIDENCE is sharpened.
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

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

describe("guard-content-probe classify — empty stdin stays §CP, evidence is honest (#3786)", () => {
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

	it("an ordinary product ADR still classifies not-guard-touching, exit 1 (non-regression)", () => {
		const body = "Term pages sort entries by score, newest first.";
		const {code, stdout} = runSh(`printf '%s\\n' "${body}" | ${INNER}`);
		expect(stdout.trim()).toBe("not-guard-touching");
		expect(code).toBe(1);
	});
});
