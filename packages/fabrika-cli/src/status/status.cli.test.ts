/**
 * The end-to-end half: the **exit status and the exact stdout bytes** a shell caller reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). Three spawns, each proving
 * something no in-process test can: that the group is reachable through the real registry, that the
 * injected `status open` form survives a real filesystem walk, and that a refusal writes **zero
 * bytes** to a real stdout. Everything else is covered in-process by `./verbs.unit.test.ts`.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {NOT_BUILDABLE, ZERO_SCOPE} from "./codes.ts";

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
			input: "",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("fabrika status, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("renders the roster off the resolved skills tree, exit 0", () => {
		const run = fabrika(["status", "menu"]);
		expect(run.code).toBe(0);
		expect(run.stdout.split("\n")[0]).toMatch(/^menu\tready\t\d+\t\d{4}-\d{2}-\d{2}T/);
		expect(run.stdout).toContain("skill\tfront-door\t/fabrika:front-door\tuser\t");
	});

	/**
	 * The injected form's whole point: it passes no flags, so its one refusal seat is unreachable and
	 * a source it cannot read becomes a field state. A refusal here would write zero bytes on exactly
	 * the cold start the front door exists for.
	 */
	it("answers `status open --field menu` at exit 0 with a stated field state", () => {
		const run = fabrika(["status", "open", "--field", "menu"]);
		expect(run.code).toBe(0);
		expect(run.stdout.split("\n")[0]).toBe("open\t1");
		expect(run.stdout).toMatch(/^field\tmenu\t(ready|empty|unknown)\t/m);
	});

	it("refuses an unbuildable surface on 12 with NOTHING on stdout", () => {
		const run = fabrika(["status", "bootstrap", "merge-queue"]);
		expect(run.code).toBe(NOT_BUILDABLE);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("is not a buildable surface");
		expect(NOT_BUILDABLE).not.toBe(ZERO_SCOPE);
	});
});
