/**
 * `status settings` end to end: the **exit status and the exact stdout bytes** a shell caller reads.
 *
 * One spawn, for what only the command adapter does: take `--root` and open both config files off
 * that real directory. The richest case carries it — a value one machine declared beside the tracked
 * file — so one run proves the flag, both layers and the detail cell naming the local file. The
 * no-file and unreadable arms read a real directory in-process in `./settings-verb.unit.test.ts`
 * (`.patterns/subprocess-test-budget.md`).
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to this copy rather than whatever the repo root installs. */
const settings = (root: string): Run => {
	try {
		const stdout = execFileSync(process.execPath, [BIN, "status", "settings", "--root", root], {
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

describe("fabrika status settings, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	let root = "";

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "fabrika-settings-"));
		writeFileSync(
			join(root, ".fabrika.jsonc"),
			'{\n\t"governedRoots": ["docs/adr/", ".fabrika.jsonc"],\n\t"laneConcurrencyCap": 2\n}\n',
		);
		writeFileSync(
			join(root, ".fabrika.local.jsonc"),
			'{\n\t// this laptop drives ten lanes\n\t"laneConcurrencyCap": 10\n}\n',
		);
	});

	afterAll(() => {
		if (root !== "") rmSync(root, {recursive: true, force: true});
	});

	it("names the machine-local file on a key that machine declared", () => {
		const run = settings(root);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain(
			"setting\tlaneConcurrencyCap\tdeclared\t10\tdeclared in .fabrika.local.jsonc\t",
		);
		expect(run.stdout).toContain(
			'setting\tgovernedRoots\tdeclared\t["docs/adr/",".fabrika.jsonc"]\tdeclared in .fabrika.jsonc\t',
		);
	});
});
