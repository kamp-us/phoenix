/**
 * `guard settings-env-guard check`'s IO boundary and exit taxonomy, over a scripted filesystem —
 * the `gate.unit.test.ts` cases from `pipeline-cli`, re-seated on the three guard exit codes.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the unexpanded brace token is the fixture under test; every case here must spell one in a plain string.
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runSettingsEnvGuard} from "./settings-env-verb.ts";

const ROOT = "/repo";
const SETTINGS = `${ROOT}/.claude/settings.json`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runSettingsEnvGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

const settings = (text: string): FakeFsOptions => ({files: {[SETTINGS]: text}});

describe("runSettingsEnvGuard", () => {
	it("passes a settings file whose env values are all literal", async () => {
		const outcome = await run(settings(JSON.stringify({env: {A: "/usr/bin", B: "1"}})));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("all 2 .claude/settings.json env value(s)");
		expect(outcome.stderr).toEqual([]);
	});

	// The post-#2495 phoenix shape: the fix was to delete the block, and that must stay green.
	it("passes a settings file with no env block at all", async () => {
		const outcome = await run(settings(JSON.stringify({permissions: {allow: []}})));
		expect(outcome.code).toBe(0);
	});

	it("reds the #2495 regression value on the violation seat, with nothing on stdout", async () => {
		const outcome = await run(
			settings(JSON.stringify({env: {KAMPUS_PIPELINE_DATA: "${CLAUDE_PROJECT_DIR}/.pipeline"}})),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("KAMPUS_PIPELINE_DATA");
	});

	it("annotates the settings file under Actions", async () => {
		const outcome = await run(settings(JSON.stringify({env: {BAD: "${X}"}})), {
			GITHUB_ACTIONS: "true",
		});
		expect(
			outcome.stderr.some((line) => line.startsWith("::error file=.claude/settings.json::")),
		).toBe(true);
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run(settings(JSON.stringify({env: {BAD: "${X}"}})));
		expect(outcome.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	// ADR 0092's floor: no settings file means the guard scanned nothing, so it cannot report clean.
	it("fails closed when the settings file is absent", async () => {
		const outcome = await run({files: {}});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("does not exist");
	});

	// Read fine, judged nothing: a malformed file is UNKNOWN, on its own seat, never clean.
	it("answers UNKNOWN on a settings file that does not parse", async () => {
		const outcome = await run(settings("{not json"));
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("does not parse");
	});

	it("answers UNKNOWN when the settings file cannot be read", async () => {
		const outcome = await run({...settings("{}"), unreadable: [SETTINGS]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when no repo root sits above the cwd", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(
				runSettingsEnvGuard({root: null, cwd: "/nowhere", env: {}}),
				fakeFs({files: {}}).layer,
			),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("no repo root");
	});
});
