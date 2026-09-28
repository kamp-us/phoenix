/**
 * The end-to-end half: the **exact stdout bytes** a shell caller reads from `wire read`, through the
 * adapter that binds its argv.
 *
 * Only a subprocess proves that binding, and each `it` costs one cold node+TS load of `bin.ts` — so
 * spawn count is this file's cost (`.patterns/subprocess-test-budget.md`). One spawn: a refusal's
 * exit status reaching the caller is `../emit.cli.test.ts`'s, over the drain every adapter shares.
 * Everything else about these verbs is covered in-process by `./verbs.unit.test.ts`.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the repo root installs. */
const fabrika = (args: ReadonlyArray<string>, stdin: string): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env: {...process.env, FABRIKA_SKIP_INFER: "1"},
			input: stdin,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("fabrika wire, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("answers a conforming artifact with the exact stdout bytes, exit 0", () => {
		const run = fabrika(
			["wire", "read", "--format", "acceptance-criteria"],
			"### Acceptance criteria\n- [ ] the read is total\n- [x] the registry is the seam\n",
		);
		expect(run.code).toBe(0);
		expect(run.stdout).toBe(
			"found\tacceptance-criteria\t2\nopen\tthe read is total\nchecked\tthe registry is the seam\n",
		);
	});
});
