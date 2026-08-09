/**
 * The end-to-end half: the **exit status and the exact stdout bytes** a shell caller reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). Two spawns: one answer and one
 * refusal, the pair that cannot be established in-process. Everything else about these verbs is
 * covered in-process by the `*-verb.unit.test.ts` files beside this one.
 *
 * Both cases are hermetic: `ui manifest` reads this repo's own committed convention paths, and the
 * refusal is an operand check that runs before any IO — no browser, no network, no lane.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {OFF_VOCABULARY} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the repo root installs. */
const fabrika = (args: ReadonlyArray<string>): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1"},
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("fabrika ui, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("answers the design surfaces as one JSON object on stdout, exit 0", () => {
		const run = fabrika(["ui", "manifest"]);
		expect(run.code).toBe(0);
		expect(Object.keys(JSON.parse(run.stdout)).sort()).toEqual([
			"goldenPointer",
			"harness",
			"inventory",
			"lawSource",
			"manifest",
			"registry",
		]);
	});

	it("refuses an off-grammar set name with NOTHING on stdout", () => {
		const run = fabrika(["ui", "render", "--out", "After", "--surface", "/pano"]);
		expect(run.code).toBe(OFF_VOCABULARY);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain('ui render: --out "After" is not a kebab-case set name.');
	});
});
