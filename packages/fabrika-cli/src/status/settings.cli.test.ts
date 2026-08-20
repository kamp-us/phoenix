/**
 * `status settings` end to end: the **exit status and the exact stdout bytes** a shell caller reads.
 *
 * Three spawns, one per case the verb's whole design turns on — no file, a declared value, and a
 * file that exists and cannot be read. Only a subprocess proves that the last one writes zero bytes
 * to a real stdout; everything else is covered in-process by `./settings-verb.unit.test.ts`
 * (`.patterns/subprocess-test-budget.md`).
 *
 * The unreadable case is a **directory** named `.fabrika.jsonc` rather than a chmod'd file: `EISDIR`
 * is raised for every user, where a permission bit is not a fault for root and the case would
 * silently pass as `Absent` in a container that runs as one.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";

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
	let base = "";
	const at = (name: string) => join(base, name);

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "fabrika-settings-"));
		mkdirSync(at("no-file"));
		mkdirSync(at("declared"));
		writeFileSync(
			join(at("declared"), ".fabrika.jsonc"),
			'{\n\t// this repo governs two roots\n\t"governedRoots": [".decisions/", ".fabrika.jsonc"]\n}\n',
		);
		mkdirSync(at("unreadable"));
		mkdirSync(join(at("unreadable"), ".fabrika.jsonc"));
	});

	afterAll(() => {
		if (base !== "") rmSync(base, {recursive: true, force: true});
	});

	it("prints the full default set at exit 0 where no config was written", () => {
		const run = settings(at("no-file"));
		expect(run.code).toBe(0);
		expect(run.stdout.split("\n")[0]).toMatch(
			/^settings\tresolved\t\d+\t0\t0\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
		);
		expect(run.stdout).toMatch(/^setting\tgovernedRoots\tdefault\t/m);
		expect(run.stdout).not.toContain("\tdeclared\t");
	});

	it("marks the declared key `declared` and its siblings `default`", () => {
		const run = settings(at("declared"));
		expect(run.code).toBe(0);
		expect(run.stdout.split("\n")[0]).toMatch(/^settings\tresolved\t\d+\t1\t0\t/);
		expect(run.stdout).toContain(
			'setting\tgovernedRoots\tdeclared\t[".decisions/",".fabrika.jsonc"]\t-\t',
		);
	});

	it("refuses on 11 with NOTHING on stdout when the config exists and cannot be read", () => {
		const run = settings(at("unreadable"));
		expect(run.code).toBe(PRECONDITION_UNKNOWN);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("resolve UNKNOWN");
		expect(run.stderr).toMatch(/^setting\tgovernedRoots\tunknown\tUNKNOWN\t/m);
	});
});
