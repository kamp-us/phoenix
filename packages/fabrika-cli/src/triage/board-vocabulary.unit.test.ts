/**
 * A foreign board vocabulary, proven at the three verbs that write it (#6294).
 *
 * Kept apart from `apply-verb.unit.test.ts` and `park-verb.unit.test.ts` because the claim under
 * test is not either verb's own logic but the one thing they share: what they reconcile against is
 * the *resolved* vocabulary, never the compiled-in default.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import {ok} from "../io/git.ts";
import type {StdinRead} from "../io/stdin.ts";
import {runBootstrap} from "../status/bootstrap-verb.ts";
import {runApply} from "./apply-verb.ts";
import {
	CWD,
	type GuardedSeams,
	guardedShell,
	triageContext,
} from "./claim-fixtures.test-support.ts";
import {OFF_VOCABULARY} from "./codes.ts";
import {runPark} from "./park-verb.ts";

const ISSUE = /GET .*\/repos\/o\/r\/issues\/4312$/;
const LABELS = /GET .*\/repos\/o\/r\/labels\?/;
const REMOVE = /DELETE .*\/repos\/o\/r\/issues\/4312\/labels\//;
const ADD = /POST .*\/repos\/o\/r\/issues\/4312\/labels$/;
const COMMENT = /POST .*\/repos\/o\/r\/issues\/4312\/comments$/;

/** What one matching request carried as its JSON body — where the labels now travel. */
const bodyFor = (seams: GuardedSeams, pattern: RegExp): string => {
	const at = seams.requests.findIndex((line) => pattern.test(line));
	return at < 0 ? "" : (seams.bodies[at] ?? "");
};

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

const issue = (labels: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4312,
		title: "t",
		body: BODY,
		state: "open",
		labels: labels.map((name) => ({name})),
		html_url: "https://example.test/issues/4312",
		milestone: null,
	}),
});

/** Every label the foreign board can produce, as the repo's own label set reads back. */
const FOREIGN_LABELS: HttpReply = {
	status: 200,
	body: JSON.stringify(
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
		].map((name) => ({name})),
	),
};

const applyOptions = {
	issue: 4312,
	type: "task",
	priority: "sev2",
	readyFor: "agent",
	home: null as number | null,
	lane: "team:infra" as string | null,
	blockedBy: [] as ReadonlyArray<number>,
	token: null as string | null,
	repo: null,
	json: false,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	cwd: CWD,
};

describe("triage apply under a declared board vocabulary", () => {
	/** Observed: new, on `sev1`. Read back: the whole triaged shape in the repo's own vocabulary. */
	const script = (): ReadonlyArray<Scripted> => [
		[once(ISSUE), issue(["state:new", "sev1"])],
		[ISSUE, issue(["type:task", "sev2", "state:ready", "ready-for:agent", "team:infra"])],
		[LABELS, FOREIGN_LABELS],
		[REMOVE, {status: 200, body: "[]"}],
		[ADD, {status: 200, body: "[]"}],
	];

	it("writes the repo's own type, priority, status and lane", async () => {
		const shell = guardedShell(script());
		const out = await Effect.runPromise(
			Effect.provide(runApply(applyOptions), triageContext(shell, FOREIGN)),
		);
		expect(out.code).toBe(0);
		const added = bodyFor(shell, ADD);
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
		expect(shell.requests).toEqual([]);
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
		expect(shell.requests).toEqual([]);
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
			[COMMENT, {status: 201, body: JSON.stringify({id: 1, html_url: "https://example.test/c/1"})}],
			[REMOVE, {status: 200, body: "[]"}],
			[ADD, {status: 200, body: "[]"}],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runPark({
					issue: 4312,
					token: null as string | null,
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
		expect(shell.bodies.some((body) => body.includes("state:blocked"))).toBe(true);
	});
});

describe("status bootstrap under a declared board vocabulary", () => {
	const LIST = /GET .*\/repos\/o\/r\/labels\?/;
	const CREATE = /POST .*\/repos\/o\/r\/labels$/;

	const run = (config: string | null) => {
		const shell = guardedShell([
			[LIST, {status: 200, body: "[]"}],
			[CREATE, {status: 201, body: "{}"}],
		]);
		const files = config === null ? {} : {[`${CWD}/.fabrika.jsonc`]: config};
		return Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "label-taxonomy",
					path: null,
					json: true,
					repoRoot: CWD,
					configSource: config === null ? {_tag: "Absent"} : {_tag: "Text", text: config},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.merge(shell.layer, fakeFs({files}).layer),
			),
		).then(() => shell);
	};

	const created = (seams: GuardedSeams): string =>
		seams.bodies.filter((_, at) => CREATE.test(seams.requests[at] ?? "")).join(" ");

	it("creates the resolved taxonomy, never the shipped one", async () => {
		const wrote = created(await run(FOREIGN));
		for (const label of ["state:new", "state:ready", "state:blocked", "sev1", "type:task"]) {
			expect(wrote).toContain(label);
		}
		expect(wrote).not.toContain("status:needs-triage");
		expect(wrote).not.toContain("type:bug");
	});

	it("creates phoenix's taxonomy for a repo that declared nothing", async () => {
		const wrote = created(await run(null));
		expect(wrote).toContain("status:needs-triage");
		expect(wrote).toContain("type:bug");
	});

	// The fail-open this pins is a write, not a readout: an unlocated root reads no file, resolves
	// the shipped taxonomy and mints it into a repo that may have declared another (#4285's
	// mechanism, arriving from the other direction).
	it("writes nothing when the config could not be read", async () => {
		const shell = guardedShell([
			[LIST, {status: 200, body: "[]"}],
			[CREATE, {status: 201, body: "{}"}],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runBootstrap({
					surfaceId: "label-taxonomy",
					path: null,
					json: true,
					repoRoot: CWD,
					configSource: {_tag: "Unreadable", reason: "cannot resolve the repo root"},
					repo: ok("o/r"),
					stdin: Effect.succeed({_tag: "NoStdin"} as StdinRead),
				}),
				Layer.merge(shell.layer, fakeFs({files: {}}).layer),
			),
		);
		expect(out.code).toBe(11);
		expect(shell.requests.some((line) => CREATE.test(line))).toBe(false);
	});
});
