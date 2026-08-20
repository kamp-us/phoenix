/**
 * The committed `.fabrika.schema.json` is reconciled where a merge can be blocked.
 *
 * A reconcile verb nobody invokes reds only when a person happens to run it, and the stale document
 * it fails to catch ships `"additionalProperties": false` — so an adopter's editor reds a key that is
 * in fact valid (#6488). This test is that invocation: the `packages unit tests` CI job runs it on
 * every PR that touches the registry or the committed file, and a stale file fails the job.
 *
 * It runs the real verb in a subprocess against this checkout, because the answer only exists at the
 * process boundary — the verb resolves the repo root from its cwd, which an in-process call fakes.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the cwd's repo installs. */
const run = (argv: ReadonlyArray<string>): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...argv], {
			cwd: REPO_ROOT,
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

describe("the committed schema and the key registry", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("agree — regenerate with `fabrika config schema --write` if this reds", () => {
		const out = run(["config", "schema"]);
		expect(`${out.stderr}${out.stdout}`).toContain("agrees");
		expect(out.code).toBe(0);
	});
});
