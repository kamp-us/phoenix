/**
 * The `--filter-placement` refusal each read verb's adapter makes before any verb runs, over a real
 * subprocess. `review scope` and `review diff` take the placement nowhere else, so no in-process
 * suite reaches this check; what `review preview` does with the placement it is handed is proved
 * in-process in `preview-verb.unit.test.ts`.
 */
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

const fabrika = (
	verb: string,
	args: ReadonlyArray<string>,
): {readonly code: number; readonly stdout: string; readonly stderr: string} => {
	try {
		return {
			code: 0,
			stdout: execFileSync(process.execPath, [BIN, "review", verb, ...args], {
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: {...process.env, FABRIKA_SKIP_INFER: "1"},
				stdio: ["pipe", "pipe", "pipe"],
			}),
			stderr: "",
		};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("review read verbs", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it.each([
		"scope",
		"diff",
		"preview",
	])("%s rejects before filtering before reading a subject", (verb) => {
		const run = fabrika(verb, ["4321", "--filter-placement=before"]);
		expect(run.code).toBe(10);
		expect(run.stderr).toContain("must be `after`");
	});
});
