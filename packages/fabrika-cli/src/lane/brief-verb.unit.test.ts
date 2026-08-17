/** `lane brief` — the three shell prompts it prints, and every refusal that prints none. */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {RULES, read as readBrief} from "../wire/lane-brief.ts";
import {runBrief} from "./brief-verb.ts";
import {
	ISSUE_UNRESOLVED,
	LANE_ABSENT,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
	NO_SHELL,
	PR_AMBIGUOUS,
	TASK_UNKNOWN,
} from "./codes.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const ROOT = ".fabrika/lanes";
const ISSUE_URL = "https://github.com/o/r/issues/5751";
const PR_URL = "https://github.com/o/r/pull/5790";
const TITLE = "the operator hand-writes every spawn prompt";

const ISSUE_READ = /^gh api repos\/o\/r\/issues\/5751$/;
const CHILD_READ = /^gh api repos\/o\/r\/issues\/5729$/;
const PR_SEARCH = /^gh api --paginate search\/issues/;

const issuePayload = (number: number, url: string): ExecResult =>
	okOut(
		JSON.stringify({
			number,
			title: TITLE,
			body: "## What is wrong\n\nNothing prints it, nothing records it.",
			state: "open",
			labels: [{name: "type:feature"}],
			html_url: url,
		}),
	);

const pullRows = (...rows: ReadonlyArray<readonly [number, string]>): ExecResult =>
	okOut(rows.map(([number, url]) => `${number}\t${url}`).join("\n"));

/** A single-issue lane at `lane`, with one log line per operator event already recorded. */
const lane = (id: string, events: ReadonlyArray<string>) =>
	fakeFs({
		files: {
			[`${ROOT}/${id}/workflow.json`]: coderTemplateText(),
			[`${ROOT}/${id}/events.jsonl`]:
				events.length === 0
					? null
					: `${events
							.map((event) =>
								JSON.stringify({
									task: "issue",
									event: `ISSUE.${event}`,
									at: "2026-08-17T00:00:00Z",
								}),
							)
							.join("\n")}\n`,
		},
	});

const options = {
	root: ROOT,
	lane: "5751",
	task: null as string | null,
	repo: null as string | null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	fs: ReturnType<typeof fakeFs>,
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runBrief({...options, ...overrides}),
			Layer.merge(fs.layer, fakeShell(script).layer),
		),
	);

describe("lane brief", () => {
	it("briefs the builder on a `build` state, with no PR when construction has none", async () => {
		const out = await run(lane("5751", ["WIP"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_SEARCH, okOut("")],
		]);

		expect(out.code).toBe(0);
		const brief = readBrief(out.stdout);
		expect(brief).toMatchObject({
			_tag: "Found",
			value: {lane: "5751", task: "issue", state: "build", shell: "builder", issue: ISSUE_URL},
		});
		expect(out.stdout).toContain(RULES);
	});

	it("briefs the reviewer on a `review` state, carrying the one open PR that traces to the issue", async () => {
		const out = await run(lane("5751", ["WIP", "DONE"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_SEARCH, pullRows([5790, PR_URL])],
		]);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {state: "review", shell: "reviewer", issue: ISSUE_URL, pr: PR_URL},
		});
	});

	it("briefs the shipper on a `ship` state", async () => {
		const out = await run(lane("5751", ["WIP", "DONE", "PASS"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_SEARCH, pullRows([5790, PR_URL])],
		]);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {state: "ship", shell: "shipper", pr: PR_URL},
		});
	});

	it("carries URLs only — no title, no body, no verdict text", async () => {
		const out = await run(lane("5751", ["WIP", "DONE"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_SEARCH, pullRows([5790, PR_URL])],
		]);

		expect(out.stdout).not.toContain(TITLE);
		expect(out.stdout).not.toContain("Nothing prints it");
	});

	it("resolves an emitted epic lane's task to the child issue its name carries", async () => {
		const fs = fakeFs({
			files: {
				[`${ROOT}/5680/workflow.json`]: JSON.stringify({
					id: "epic-5680",
					version: 1,
					machine: {
						id: "epic-5680",
						initial: "phase1",
						context: {issue_5729: {retries: 0, maxRetries: 2}},
						states: {
							phase1: {
								type: "parallel",
								states: {
									issue_5729: {
										initial: "queued",
										states: {
											queued: {on: {"ISSUE_5729.WIP": "build"}},
											build: {on: {"ISSUE_5729.DONE": "review"}},
											review: {on: {"ISSUE_5729.PASS": "ship"}},
											ship: {on: {"ISSUE_5729.DONE": "shipped"}},
											shipped: {type: "final"},
										},
									},
								},
								onDone: [{target: "complete", guard: "noErrors"}, {target: "tripped"}],
							},
							complete: {type: "final"},
							tripped: {type: "final"},
						},
					},
				}),
				[`${ROOT}/5680/events.jsonl`]: `${JSON.stringify({
					task: "issue_5729",
					event: "ISSUE_5729.WIP",
					at: "2026-08-17T00:00:00Z",
				})}\n`,
			},
		});
		const out = await run(
			fs,
			[
				[CHILD_READ, issuePayload(5729, "https://github.com/o/r/issues/5729")],
				[PR_SEARCH, okOut("")],
			],
			{lane: "5680", task: "issue_5729"},
		);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {lane: "5680", task: "issue_5729", issue: "https://github.com/o/r/issues/5729"},
		});
	});

	it("refuses a leaf state that routes to no shell, naming the state", async () => {
		const out = await run(lane("5751", []), []);

		expect(out.code).toBe(NO_SHELL);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain('"queued"');
	});

	it("refuses a `human:*` park the same way — a park is never a dispatch", async () => {
		const out = await run(lane("5751", ["WIP", "DONE", "PASS", "BLOCKED"]), []);

		expect(out.code).toBe(NO_SHELL);
		expect(out.stderr.join("\n")).toContain("human:cp-approval");
	});

	it("refuses a task the machine does not hold", async () => {
		const out = await run(lane("5751", ["WIP"]), [], {task: "issue_9999"});

		expect(out.code).toBe(TASK_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("refuses a lane that is not there", async () => {
		const out = await run(fakeFs({files: {}}), []);

		expect(out.code).toBe(LANE_ABSENT);
		expect(out.stdout).toBe("");
	});

	it("refuses a lane record that was read in full and does not replay", async () => {
		const fs = fakeFs({
			files: {
				[`${ROOT}/5751/workflow.json`]: coderTemplateText(),
				[`${ROOT}/5751/events.jsonl`]: "{not json}\n",
			},
		});
		const out = await run(fs, []);

		expect(out.code).toBe(MALFORMED_RECORD);
	});

	it("refuses when neither the task nor the lane names an issue", async () => {
		const out = await run(lane("scratch", ["WIP"]), [], {lane: "scratch"});

		expect(out.code).toBe(ISSUE_UNRESOLVED);
		expect(out.stdout).toBe("");
	});

	it("refuses when the issue is proven absent", async () => {
		const out = await run(lane("5751", ["WIP"]), [
			[ISSUE_READ, errOut("gh: Not Found (HTTP 404)")],
		]);

		expect(out.code).toBe(ISSUE_UNRESOLVED);
	});

	it("refuses when the issue could not be read — UNKNOWN, never a brief", async () => {
		const out = await run(lane("5751", ["WIP"]), [
			[ISSUE_READ, errOut("gh: Server Error (HTTP 503)")],
		]);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("refuses several open PRs, naming every candidate", async () => {
		const out = await run(lane("5751", ["WIP", "DONE"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_SEARCH, pullRows([5790, PR_URL], [5791, "https://github.com/o/r/pull/5791"])],
		]);

		expect(out.code).toBe(PR_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain("#5790");
		expect(out.stderr.join("\n")).toContain("#5791");
	});

	it("refuses zero open PRs where the state needs one", async () => {
		const out = await run(lane("5751", ["WIP", "DONE", "PASS"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_SEARCH, okOut("")],
		]);

		expect(out.code).toBe(PR_AMBIGUOUS);
		expect(out.stdout).toBe("");
	});
});
