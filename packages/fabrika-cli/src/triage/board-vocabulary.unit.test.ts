/**
 * A foreign board vocabulary, proven at the three verbs that write it (#6294).
 *
 * Kept apart from `apply-verb.unit.test.ts` and `park-verb.unit.test.ts` because the claim under
 * test is not either verb's own logic but the one thing they share: what they reconcile against is
 * the *resolved* vocabulary, never the compiled-in default.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {ok} from "../io/git.ts";
import type {StdinRead} from "../io/stdin.ts";
import {runBootstrap} from "../status/bootstrap-verb.ts";
import {runApply} from "./apply-verb.ts";
import {CWD, guardedShell, triageContext} from "./claim-fixtures.test-support.ts";
import {OFF_VOCABULARY} from "./codes.ts";
import {runPark} from "./park-verb.ts";

const ISSUE = /^gh api repos\/o\/r\/issues\/4312$/;
const LABELS = /^gh api --paginate repos\/o\/r\/labels/;
const REMOVE = /^gh api --method DELETE repos\/o\/r\/issues\/4312\/labels\//;
const ADD = /^gh api --method POST repos\/o\/r\/issues\/4312\/labels /;
const COMMENT = /^gh api --method POST repos\/o\/r\/issues\/4312\/comments /;

/** The whole board a hypothetical adopting repo declares: its own types, priorities and lanes. */
const FOREIGN = JSON.stringify({
	boardVocabulary: {
		statuses: {needsTriage: "state:new", triaged: "state:ready", needsInfo: "state:blocked"},
		types: ["task", "defect"],
		priorities: ["sev1", "sev2"],
		audiences: ["human", "agent"],
		standingLanes: ["team:infra"],
	},
});

const BODY = "## Summary\n\ns\n\n### Acceptance criteria\n\n- [ ] the one criterion\n";

const issue = (labels: ReadonlyArray<string>): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4312,
			title: "t",
			body: BODY,
			state: "open",
			labels: labels.map((name) => ({name})),
			html_url: "https://example.test/issues/4312",
			milestone: null,
		}),
	);

/** Every label the foreign board can produce, as the repo's own label set reads back. */
const FOREIGN_LABELS = okOut(
	[
		"type:task",
		"type:defect",
		"sev1",
		"sev2",
		"state:new",
		"state:ready",
		"state:blocked",
		"ready-for:agent",
		"ready-for:human",
		"team:infra",
	].join("\n"),
);

const applyOptions = {
	issue: 4312,
	type: "task",
	priority: "sev2",
	readyFor: "agent",
	home: null as number | null,
	lane: "team:infra" as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	cwd: CWD,
};

describe("triage apply under a declared board vocabulary", () => {
	/** Observed: new, on `sev1`. Read back: the whole triaged shape in the repo's own vocabulary. */
	const script = (): ReadonlyArray<readonly [RegExp, ExecResult]> => [
		[once(ISSUE), issue(["state:new", "sev1"])],
		[ISSUE, issue(["type:task", "sev2", "state:ready", "ready-for:agent", "team:infra"])],
		[LABELS, FOREIGN_LABELS],
		[REMOVE, okOut("[]")],
		[ADD, okOut("[]")],
	];

	it("writes the repo's own type, priority, status and lane", async () => {
		const shell = guardedShell(script());
		const out = await Effect.runPromise(
			Effect.provide(runApply(applyOptions), triageContext(shell, FOREIGN)),
		);
		expect(out.code).toBe(0);
		const added = shell.calls.find((line) => ADD.test(line)) ?? "";
		for (const label of ["type:task", "sev2", "state:ready", "team:infra"]) {
			expect(added).toContain(label);
		}
		expect(added).not.toContain("status:triaged");
	});

	it("refuses a type off the declared vocabulary before it reads the board", async () => {
		const shell = guardedShell(script());
		const out = await Effect.runPromise(
			Effect.provide(runApply({...applyOptions, type: "bug"}), triageContext(shell, FOREIGN)),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.join(" ")).toContain("task, defect");
		expect(shell.calls).toEqual([]);
	});

	/** The lanes are an open set now, so this decode is the only thing standing between a typo'd
	 * `--lane` and a label the lane facet has no authority to remove. */
	it("refuses a lane off the declared set — including the one phoenix ships", async () => {
		const shell = guardedShell(script());
		const out = await Effect.runPromise(
			Effect.provide(
				runApply({...applyOptions, lane: "wayfinder:backlog"}),
				triageContext(shell, FOREIGN),
			),
		);
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.join(" ")).toContain("team:infra");
		expect(shell.calls).toEqual([]);
	});

	it("accepts a lane the declaring repo named", async () => {
		const out = await Effect.runPromise(
			Effect.provide(runApply(applyOptions), triageContext(guardedShell(script()), FOREIGN)),
		);
		expect(out.code).toBe(0);
	});
});

describe("triage park under a declared board vocabulary", () => {
	it("demotes to the repo's own needs-info status, not `status:needs-info`", async () => {
		const shell = guardedShell([
			[once(ISSUE), issue(["type:task", "sev1", "state:ready"])],
			[ISSUE, issue(["state:blocked"])],
			[LABELS, FOREIGN_LABELS],
			[COMMENT, okOut(JSON.stringify({id: 1, html_url: "https://example.test/c/1"}))],
			[REMOVE, okOut("[]")],
			[ADD, okOut("[]")],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runPark({
					issue: 4312,
					repo: null,
					json: false,
					env: {CLAUDE_PIPELINE_REPO: "o/r"},
					stdin: Effect.succeed({_tag: "Text", text: "what would unblock it"} as StdinRead),
					cwd: CWD,
				}),
				triageContext(shell, FOREIGN),
			),
		);
		expect(out.code).toBe(0);
		expect(shell.calls.some((line) => line.includes("state:blocked"))).toBe(true);
	});
});

describe("status bootstrap under a declared board vocabulary", () => {
	const LIST = /^gh api --paginate repos\/o\/r\/labels/;
	const CREATE = /^gh api --method POST repos\/o\/r\/labels /;

	const run = (config: string | null) => {
		const shell = guardedShell([
			[LIST, okOut("")],
			[CREATE, okOut("{}")],
		]);
		const files = config === null ? {} : {[`${CWD}/.fabrika.jsonc`]: config};
		return Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "label-taxonomy",
					path: null,
					json: true,
					repoRoot: CWD,
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.merge(shell.layer, fakeFs({files}).layer),
			),
		).then(() => ({calls: shell.calls}));
	};

	it("creates the resolved taxonomy, never the shipped one", async () => {
		const {calls} = await run(FOREIGN);
		const wrote = calls.filter((line) => CREATE.test(line)).join(" ");
		for (const label of ["state:new", "state:ready", "state:blocked", "sev1", "type:task"]) {
			expect(wrote).toContain(label);
		}
		expect(wrote).not.toContain("status:needs-triage");
		expect(wrote).not.toContain("type:bug");
	});

	it("creates phoenix's taxonomy for a repo that declared nothing", async () => {
		const {calls} = await run(null);
		const wrote = calls.filter((line) => CREATE.test(line)).join(" ");
		expect(wrote).toContain("status:needs-triage");
		expect(wrote).toContain("type:bug");
	});
});
