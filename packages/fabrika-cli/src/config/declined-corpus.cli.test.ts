/**
 * A repo that declines `decisionsDir`, end to end: what `adr` and `governance` do about it.
 *
 * The behaviour only exists at the process boundary — each verb resolves the key from the **cwd**
 * it is run in, so an in-process test would have to fake the one thing under test. Three spawns:
 * per the ruling (R11.1 on #5603) `adr` refuses to write and `governance`'s contradiction half
 * refuses rather than answering `no-overlap` over a corpus that does not exist, and per #6433
 * `guard decisions-index validate` skips on exit 0 rather than reporting the ADR 0092 zero-scope
 * red at a repo whose config is valid.
 *
 * No spawn reaches the network: each answers at the config read, ahead of any `gh` call.
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
		// This verb does carry `--dir`, so the remedy clause is true here — it is the reference the
		// two flagless/differently-flagged callers below must not inherit (#6433).
		expect(out.stderr).toContain("Point --dir at a corpus to read one anyway.");
		expect(readdirSync(root)).toEqual([".fabrika.jsonc"]);
	});

	// The whole point of #6433: an ADR 0092 red here would make a valid config a permanent CI
	// failure, and its wording ("Is the repo root correct?") would send the reader after a defect
	// that is not there.
	it("skips `guard decisions-index validate` on exit 0 rather than reporting zero scope", () => {
		// --root because the fixture is a bare directory with no `package.json` for root discovery
		// to find, and this test is about the config read, not about that walk.
		const out = run(root, ["guard", "decisions-index", "validate", "--root", root]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("declines `decisionsDir`");
		// `--root` is this verb's only flag; there is no override to point anywhere, so the skip
		// message must offer none rather than send the reader after `adr`'s `--dir` (#6433).
		expect(out.stdout).not.toContain("Point ");
		expect(out.stderr).toBe("");
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
