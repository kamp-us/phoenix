/**
 * The end-to-end half: the **exit status and the exact stdout bytes** a shell caller reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`). One spawn, for the one thing no
 * in-process test reaches: `status open --field` narrows the readout inside the command adapter, so
 * only a real run proves the injected form answers one field over a real filesystem walk.
 * Registration is `./command.unit.test.ts`'s; every verb's outcome is `./verbs.unit.test.ts`'s.
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
});
