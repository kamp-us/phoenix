/**
 * A repo that declines `decisionsDir`, end to end: what `adr` and `governance` do about it.
 *
 * The behaviour only exists at the process boundary — both verbs resolve the key from the **cwd**
 * they are run in, so an in-process test would have to fake the one thing under test. Two spawns,
 * one per half of the ruling (R11.1 on #5603): `adr` refuses to write, and `governance`'s
 * contradiction half refuses rather than answering `no-overlap` over a corpus that does not exist.
 *
 * Neither spawn reaches the network: both refuse at the config read, ahead of any `gh` call.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {CORPUS_DECLINED} from "../adr/codes.ts";
import {ZERO_SCOPE} from "../governance/codes.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the cwd's repo installs. */
const run = (cwd: string, argv: ReadonlyArray<string>): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...argv], {
			cwd,
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

describe("a repo that keeps no decision corpus", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	let root = "";

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "fabrika-declined-"));
		writeFileSync(join(root, ".fabrika.jsonc"), '{\n\t"decisionsDir": null\n}\n', "utf8");
	});

	afterAll(() => {
		if (root !== "") rmSync(root, {recursive: true, force: true});
	});

	it("refuses `adr new` on its own code and writes nothing", () => {
		const out = run(root, ["adr", "new", "0999", "a-decision-nobody-can-keep"]);
		expect(out.code).toBe(CORPUS_DECLINED);
		expect(out.stdout).toBe("");
		expect(out.stderr).toContain("declines `decisionsDir`");
		expect(readdirSync(root)).toEqual([".fabrika.jsonc"]);
	});

	it("refuses `governance sweep` and names the half this repo can still run", () => {
		const out = run(root, ["governance", "sweep", "--landed", "0240"]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		// The word this verb must never print here: `no-overlap` reads as "checked, nothing found".
		expect(out.stderr).not.toContain("no-overlap\n");
		expect(out.stderr).toContain("governance guards");
	});
});
