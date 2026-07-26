import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../../test-budget.ts";

// The stdin/exit contract of `pipeline-cli class-probe classify` over the shared bin. The #3786
// exposure is an IO/stdin-delivery fact (an empty read must not read as a gate-free PR), so it is
// exercised over the ACTUAL bin with real stdin wiring, not the pure core.
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

const INNER = `node "${BIN}" class-probe classify --namespaces`;

// The three empty-stdin shapes the #3786 report verified reproduce verbatim, each wired by real
// shell redirection: an empty pipe (`printf ''`), `< /dev/null`, and a closed fd 0 (`<&-`).
const EMPTY_SHAPES: ReadonlyArray<readonly [string, string]> = [
	["printf '' (empty pipe)", `printf '' | ${INNER}`],
	["< /dev/null", `${INNER} < /dev/null`],
	["closed stdin <&-", `${INNER} <&-`],
];

describe("class-probe classify — empty stdin fails closed to review-code, never an empty set (#3786)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	for (const [name, cmd] of EMPTY_SHAPES) {
		it(`${name}: emits review-code (has-code), never an empty required-gate set`, () => {
			const {code, stdout, stderr} = runSh(cmd);
			// The load-bearing assertion: the required-namespace set is NON-EMPTY. An empty set would
			// make ship-it Step 1's conjunction vacuously true (zero gates → un-gated merge).
			expect(stdout.trim().split("\n").filter(Boolean)).toEqual(["review-code"]);
			expect(code).toBe(0);
			// And it is LOUD — a dropped stdin is visible at the point it happens, not silent.
			expect(stderr).toContain("read 0 files");
			expect(stderr).toContain("#3786");
		});
	}

	it("piped real content is unaffected — a docs path still classifies review-doc (non-regression)", () => {
		const {code, stdout} = runSh(`printf 'DEVELOPMENT.md\\n' | ${INNER}`);
		expect(stdout.trim().split("\n").filter(Boolean)).toEqual(["review-doc"]);
		expect(code).toBe(0);
	});

	it("the default (has-*) output also fails closed to has-code on empty stdin", () => {
		const {stdout} = runSh(`printf '' | node "${BIN}" class-probe classify`);
		expect(stdout.trim().split("\n").filter(Boolean)).toEqual(["has-code"]);
	});
});

describe("class-probe --files-from — an unreadable path refuses; an empty one still classifies (#4061)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("an UNREADABLE --files-from exits non-zero with its own reason, never as a change set", () => {
		const {code, stdout, stderr} = runSh(`${INNER} --files-from /nonexistent/changed.txt`);
		expect(code).toBe(4);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain("could not read --files-from");
		expect(stderr).toContain("#4061");
	});

	it("a readable-but-EMPTY --files-from still classifies, fail-closed to review-code", () => {
		const {code, stdout, stderr} = runSh(`${INNER} --files-from /dev/null`);
		// The non-collapse, asserted on the observable pair: same "zero files" shape as above,
		// opposite exit and opposite output.
		expect(code).toBe(0);
		expect(stdout.trim().split("\n").filter(Boolean)).toEqual(["review-code"]);
		expect(stderr).toContain("read 0 files");
	});

	it("doc-vocab-surface-only refuses on an unreadable --files-from too (exit 4, not its exit-1 verdict)", () => {
		const {code, stdout} = runSh(
			`node "${BIN}" class-probe doc-vocab-surface-only --files-from /nonexistent/changed.txt`,
		);
		expect(code).toBe(4);
		expect(stdout.trim()).toBe("");
	});
});
