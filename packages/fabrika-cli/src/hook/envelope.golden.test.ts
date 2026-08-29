/**
 * The fabrika hook surface, proven end to end against captured real payloads (ADR 0180).
 *
 * Three things have to hold together for the surface to be real, and this file refuses to let any
 * one of them be assumed:
 *
 *   1. The **committed declaration** is what gets run. The argv comes out of
 *      `claude-plugins/fabrika/hooks.json` for the plugin surface and `.claude/settings.json` for
 *      this repo's own, never out of a literal here — so a test that passes cannot be exercising a
 *      verb the declaration does not name (the false-green this campaign keeps paying for). Which
 *      events each document may carry is asserted per document, because that split is a decision
 *      (ADR 0337) and not a filing convenience.
 *   2. The **bytes** are the captured ones. `__fixtures__/*.golden.json` are what Claude Code
 *      really wrote to a hook's stdin; `__fixtures__/PROVENANCE.md` says how, per build. A
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
import {MALFORMED_ENVELOPE, WRONG_EVENT} from "./codes.ts";
import {argvOf, declaredHooks, violations} from "./declaration.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const HOOKS_JSON = "../../../../claude-plugins/fabrika/hooks.json";
const SETTINGS_JSON = "../../../../.claude/settings.json";

const surface = declaredHooks(JSON.parse(readGoldenFixture(import.meta.url, HOOKS_JSON)));
const repoSurface = declaredHooks(JSON.parse(readGoldenFixture(import.meta.url, SETTINGS_JSON)));

/**
 * The hook the declaration puts on `event`, or a throw.
 *
 * Selecting by event rather than by index is what keeps these tests bound to the declaration: adding
 * a hook re-orders the array, and an index would then silently exercise a different verb than the one
 * the assertions below are written about.
 */
const declaredOn = (event: string, rows: ReadonlyArray<{event: string}> = surface) => {
	const hook = rows.find((row) => row.event === event);
	if (hook === undefined) throw new Error(`the declaration carries no ${event} hook`);
	return hook as (typeof surface)[number];
};

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
const runDeclared = (
	command: string,
	stdin: string,
	extraArgs: ReadonlyArray<string> = [],
): Run => {
	const env: NodeJS.ProcessEnv = {...process.env, FABRIKA_SKIP_INFER: "1"};
	const run = spawnSync(process.execPath, [BIN, ...argvOf(command), ...extraArgs], {
		encoding: "utf8",
		input: stdin,
		env,
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

	it("declares every hook on an event whose real envelope is committed beside this test", () => {
		expect([...new Set(surface.map((hook) => hook.event))].sort()).toEqual(["SessionStart"]);
	});

	/**
	 * The plugin travels to every adopting repo, and a `WorktreeCreate` hook preempts git worktree
	 * creation wherever it is declared — with no fail-open form, since the harness reads even the
	 * convention's never-ran codes as a creation failure. So that event lives in phoenix's own
	 * settings and may never be declared here (ADR 0337, ADR 0250).
	 */
	it("declares no provider event on the plugin surface, which adopting repos inherit", () => {
		expect(surface.filter((hook) => hook.event.startsWith("Worktree"))).toEqual([]);
	});
});

describe("this repo's own hook declaration", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("declares at least one hook — a surface with zero rows is never a pass (ADR 0092)", () => {
		expect(repoSurface.length).toBeGreaterThan(0);
	});

	it("breaks neither rule 5 (plain literal) nor rule 6 (nothing outside fabrika)", () => {
		expect(violations(repoSurface)).toEqual([]);
	});

	/**
	 * Asserted by containment, not exhaustively: a later unrelated repo hook is the repo's call to
	 * make, and reddening this package's suite over one would say nothing about fabrika. The teeth
	 * are the `Worktree*` bound — exactly one provisioning provider, here and nowhere else.
	 */
	it("carries the WorktreeCreate provider, and no second Worktree event beside it", () => {
		const events = repoSurface.map((hook) => hook.event);
		expect(events).toContain("WorktreeCreate");
		expect([...new Set(events.filter((event) => event.startsWith("Worktree")))]).toEqual([
			"WorktreeCreate",
		]);
	});

	/**
	 * 600s, not the harness default. The budget is the whole reason the hook exists: `git worktree
	 * add` fires lefthook's `post-checkout` install, which is far slower than the ~13s the harness's
	 * default worktree path allows (ADR 0178).
	 */
	it("gives the provisioning install a budget the install can finish inside", () => {
		const settings = JSON.parse(readGoldenFixture(import.meta.url, SETTINGS_JSON)) as {
			hooks: {WorktreeCreate: Array<{hooks: Array<{timeout?: number}>}>};
		};
		expect(settings.hooks.WorktreeCreate[0]?.hooks[0]?.timeout).toBe(600);
	});
});

describe("the WorktreeCreate provider, run against the captured envelope", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	const declared = declaredOn("WorktreeCreate", repoSurface);

	/**
	 * `--dry-run` is appended rather than declared: the harness adopts whatever path the hook prints,
	 * so a run that mutated nothing and printed one anyway would be the false green this event is
	 * most dangerous for. Rule 5's literal grammar cannot express a flag, so the declared command
	 * can never carry it — which is what keeps the flag a test affordance rather than a live one.
	 */
	it("constructs the path the harness would adopt, from the captured envelope's own fields", () => {
		const run = runDeclared(
			declared.command,
			readGoldenFixture(import.meta.url, "__fixtures__/worktree-create.payload.golden.json"),
			["--dry-run"],
		);
		expect(run.code).toBe(0);
		expect(run.stdout).toBe(
			"/private/tmp/fabrika-worktree-capture/repo/.claude/worktrees/capture-probe\n",
		);
	});

	it("refuses an envelope for an event it does not judge, rather than provisioning from it", () => {
		const run = runDeclared(
			declared.command,
			readGoldenFixture(import.meta.url, "__fixtures__/session-start.payload.golden.json"),
			["--dry-run"],
		);
		expect(run.code).toBe(WRONG_EVENT);
		expect(run.stdout).toBe("");
	});

	it("refuses a hand-authored envelope of the shape a doc-assumed contract would produce", () => {
		const run = runDeclared(
			declared.command,
			JSON.stringify({
				hook_event_name: "WorktreeCreate",
				worktree_path: "/tmp/x",
				base_ref: "main",
			}),
			["--dry-run"],
		);
		expect(run.code).toBe(MALFORMED_ENVELOPE);
		expect(run.stdout).toBe("");
	});
});

describe("the declared hook, run against the captured envelope", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	const declared = declaredOn("SessionStart");

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
		const run = runDeclared(declared.command, readGoldenFixture(import.meta.url, fixture));
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
		const run = runDeclared(declared.command, fabricated);
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

	it("a captured spawn carries these keys — `tool_name` is Agent, and the model is an alias", () => {
		const payload = loadGoldenPayload(
			import.meta.url,
			"__fixtures__/pre-tool-use-spawn.payload.golden.json",
		);
		expect(payload.hook_event_name).toBe("PreToolUse");
		// A `Task|Workflow` matcher fires, but the harness then sends `tool_name: "Agent"` — a hook
		// keyed on `tool_name === "Task"` would never fire. Kept as the captured record of that gap
		// even though fabrika declares no PreToolUse hook today (ADR 0331).
		expect(payload.tool_name).toBe("Agent");
		expect(payload.tool_input).toMatchObject({subagent_type: "general-purpose", model: "opus"});
	});

	it("a captured spawn that passed no model carries no `model` key at all", () => {
		const payload = loadGoldenPayload(
			import.meta.url,
			"__fixtures__/pre-tool-use-spawn-unset-model.payload.golden.json",
		);
		expect(payload.tool_input).not.toHaveProperty("model");
	});

	/**
	 * The two fields a doc-assumed contract invents are what this pins. The harness sends `name`, a
	 * slug — never `worktree_path` and never `base_ref` — so the path is *constructed* and the base
	 * is the hook's own call. v1 shipped a handler built to the invented shape and it fail-closed
	 * every worktree spawn (#2925).
	 */
	it("WorktreeCreate carries these keys and no others — `name`, not `worktree_path`", () => {
		const payload = loadGoldenPayload(
			import.meta.url,
			"__fixtures__/worktree-create.payload.golden.json",
		);
		expect(Object.keys(payload).sort()).toEqual(
			["cwd", "hook_event_name", "name", "session_id", "transcript_path"].sort(),
		);
		expect(payload.hook_event_name).toBe("WorktreeCreate");
		for (const invented of ["worktree_path", "base_ref"]) {
			expect(payload).not.toHaveProperty(invented);
		}
	});

	it("carries no operator home path — the one sanitization, applied and still applied", () => {
		for (const fixture of [
			"__fixtures__/worktree-create.payload.golden.json",
			"__fixtures__/session-start.payload.golden.json",
			"__fixtures__/pre-tool-use.payload.golden.json",
			"__fixtures__/pre-tool-use-spawn.payload.golden.json",
			"__fixtures__/pre-tool-use-spawn-unset-model.payload.golden.json",
		]) {
			expect(readGoldenFixture(import.meta.url, fixture)).toContain("/Users/<operator>/");
		}
	});
});
