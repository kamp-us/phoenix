/**
 * The fabrika hook surface, proven end to end against captured real payloads (ADR 0180).
 *
 * Three things have to hold together for the surface to be real, and this file refuses to let any
 * one of them be assumed:
 *
 *   1. The **committed declaration** is what gets run. The argv comes out of
 *      `claude-plugins/fabrika/hooks.json`, never out of a literal here — so a test that passes
 *      cannot be exercising a verb the declaration does not name (the false-green this campaign
 *      keeps paying for).
 *   2. The **bytes** are the captured ones. `__fixtures__/*.golden.json` are what Claude Code
 *      2.1.226 actually wrote to a hook's stdin; `__fixtures__/PROVENANCE.md` says how. A
 *      hand-authored envelope in the assertion path is the anti-pattern ADR 0180 exists for — v1's
 *      spawn-guard test hand-authored a `PreToolUse` envelope and so never knew the harness sends
 *      `prompt_id`, `permission_mode` and `effort`.
 *   3. The **shape** is pinned by exact key set, presences and absences both. A subset check would
 *      pass against the fabricated shape too, which is the litmus the pattern doc sets.
 */
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {loadGoldenPayload, readGoldenFixture} from "../golden-fixture.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {MALFORMED_ENVELOPE} from "./codes.ts";
import {argvOf, declaredHooks, violations} from "./declaration.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const HOOKS_JSON = "../../../../claude-plugins/fabrika/hooks.json";

const surface = declaredHooks(JSON.parse(readGoldenFixture(import.meta.url, HOOKS_JSON)));

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * `spawnSync`, not `execFileSync`: the success path has to carry **stderr** too, because the scope
 * line a verdict rests on is only asserted if it is readable on the path that produced a verdict.
 * `FABRIKA_SKIP_INFER` pins the invocation to *this* copy rather than whatever the root resolves.
 */
const runDeclared = (command: string, stdin: string): Run => {
	const run = spawnSync(process.execPath, [BIN, ...argvOf(command)], {
		encoding: "utf8",
		input: stdin,
		env: {...process.env, FABRIKA_SKIP_INFER: "1"},
	});
	return {code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? ""};
};

describe("the committed hook declaration", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("declares at least one hook — a surface with zero rows is never a pass (ADR 0092)", () => {
		expect(surface.length).toBeGreaterThan(0);
	});

	it("breaks neither rule 5 (plain literal) nor rule 6 (nothing outside fabrika)", () => {
		expect(violations(surface)).toEqual([]);
	});

	it("declares its hook on an event whose real envelope is committed beside this test", () => {
		expect(surface.map((hook) => hook.event)).toEqual(["SessionStart"]);
	});
});

describe("the declared hook, run against the captured envelope", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	const declared = surface[0];

	it.each([
		[
			"the captured SessionStart envelope",
			"__fixtures__/session-start.payload.golden.json",
			"SessionStart",
			5,
		],
		[
			"the captured PreToolUse envelope",
			"__fixtures__/pre-tool-use.payload.golden.json",
			"PreToolUse",
			10,
		],
	])("conforms on %s", (_label, fixture, event, fields) => {
		const run = runDeclared(declared!.command, readGoldenFixture(import.meta.url, fixture));
		expect(run.code).toBe(0);
		expect(run.stdout).toBe(`conforms\t${event}\t${fields}\n`);
		expect(run.stderr).toContain("bytes on fd 0");
	});

	/**
	 * The litmus the pattern doc sets: the test must FAIL against a fabricated contract. This is the
	 * exact shape v1's spawn-guard test hand-authored — plausible, and missing three fields the
	 * harness really sends plus the two every envelope carries.
	 */
	it("refuses a hand-authored envelope of the shape a doc-assumed contract would produce", () => {
		const fabricated = JSON.stringify({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: {command: "echo capture-probe"},
		});
		const run = runDeclared(declared!.command, fabricated);
		expect(run.code).toBe(MALFORMED_ENVELOPE);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("missing string fields session_id, transcript_path, cwd");
	});
});

describe("the captured envelope shape, pinned by exact key set", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("SessionStart carries these keys and no others", () => {
		const payload = loadGoldenPayload(
			import.meta.url,
			"__fixtures__/session-start.payload.golden.json",
		);
		expect(Object.keys(payload).sort()).toEqual(
			["cwd", "hook_event_name", "session_id", "source", "transcript_path"].sort(),
		);
		expect(payload.hook_event_name).toBe("SessionStart");
		expect(payload.source).toBe("startup");
	});

	it("PreToolUse carries these keys and no others — including the three v1's fabricated envelope missed", () => {
		const payload = loadGoldenPayload(
			import.meta.url,
			"__fixtures__/pre-tool-use.payload.golden.json",
		);
		expect(Object.keys(payload).sort()).toEqual(
			[
				"cwd",
				"effort",
				"hook_event_name",
				"permission_mode",
				"prompt_id",
				"session_id",
				"tool_input",
				"tool_name",
				"transcript_path",
				"tool_use_id",
			].sort(),
		);
		for (const missedByTheFabrication of ["prompt_id", "permission_mode", "effort"]) {
			expect(payload).toHaveProperty(missedByTheFabrication);
		}
	});

	it("carries no operator home path — the one sanitization, applied and still applied", () => {
		for (const fixture of [
			"__fixtures__/session-start.payload.golden.json",
			"__fixtures__/pre-tool-use.payload.golden.json",
		]) {
			expect(readGoldenFixture(import.meta.url, fixture)).toContain("/Users/<operator>/");
		}
	});
});
