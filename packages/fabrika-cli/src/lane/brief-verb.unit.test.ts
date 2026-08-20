/** `lane brief` — the three shell prompts it prints, and every refusal that prints none. */
import {resolve} from "node:path";
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import type {EntrypointRead} from "../delegate/entrypoint.ts";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {EPIC_RULES, EPIC_TAIL_RULES, RULES, read as readBrief} from "../wire/lane-brief.ts";
import {runBrief} from "./brief-verb.ts";
import {
	ISSUE_UNRESOLVED,
	LANE_ABSENT,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
	NO_SHELL,
	PR_AMBIGUOUS,
	PROOF_ABSENT,
	PROOF_AMBIGUOUS,
	TASK_UNKNOWN,
} from "./codes.ts";
import {emitMachine} from "./emit.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const ROOT = ".fabrika/lanes";
const ISSUE_URL = "https://github.com/o/r/issues/5751";
const PR_URL = "https://github.com/o/r/pull/5790";
const TITLE = "the operator hand-writes every spawn prompt";

const ISSUE_READ = /^gh api repos\/o\/r\/issues\/5751$/;
const CHILD_READ = /^gh api repos\/o\/r\/issues\/5729$/;
const PR_CLOSERS = /^gh api graphql -f query=query\(/;

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

/** One page of the closing-issue link edge — every node OPEN, since the verb filters on that. */
const closingPulls = (...rows: ReadonlyArray<readonly [number, string]>): ExecResult =>
	okOut(
		JSON.stringify({
			data: {
				repository: {
					issue: {
						closedByPullRequestsReferences: {
							pageInfo: {hasNextPage: false, endCursor: null},
							nodes: rows.map(([number, url]) => ({number, url, state: "OPEN"})),
						},
					},
				},
			},
		}),
	);

/**
 * A single-issue lane at `lane`, with one log line per operator event already recorded. `classes`
 * rides the first event, which is where a UI-class lane's own routing is decided.
 */
const lane = (
	id: string,
	events: ReadonlyArray<string>,
	classes: ReadonlyArray<string> | null = null,
) =>
	fakeFs({
		files: {
			[`${ROOT}/${id}/workflow.json`]: coderTemplateText(),
			[`${ROOT}/${id}/events.jsonl`]:
				events.length === 0
					? null
					: `${events
							.map((event, index) =>
								JSON.stringify({
									task: "issue",
									event: `ISSUE.${event}`,
									at: "2026-08-17T00:00:00Z",
									...(index === 0 && classes !== null ? {classes} : {}),
								}),
							)
							.join("\n")}\n`,
		},
	});

const EPIC = 5800;
const EPIC_URL = "https://github.com/o/r/issues/5800";
const CHILD_URL = "https://github.com/o/r/issues/5828";
const EPIC_ISSUE_READ = /^gh api repos\/o\/r\/issues\/5800$/;
const EPIC_CHILD_READ = /^gh api repos\/o\/r\/issues\/5828$/;

/** The child's range as this tree holds it: the epic branch's commit, and the build branch's tip. */
const EPIC_BASE = "58ad239e2f8b41c0d7a6935ee1c204ab5d3f9017";
const CHILD_TIP = "81c1f160c9a24e5b0f7d3821ab6c94ef0d52a7b3";
const CHILD_BRANCH = "build/5828-child-lane-eaf33a6f";
const CHILD_MESSAGE = "feat(lane): resolve the child's range (#5828)";

const REV = (rev: string) =>
	new RegExp(`^git rev-parse --verify --quiet ${rev.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\^`);
const BRANCHES = /^git for-each-ref --format=%\(refname:short\) refs\/heads$/;
const LOG_RANGE = /^git log --format=/;

/** `git log`'s framing for one commit: `<sha>\x1f<message>\x1e`. */
const logOf = (...rows: ReadonlyArray<readonly [string, string]>): ExecResult =>
	okOut(rows.map(([sha, message]) => `${sha}\x1f${message}\n\x1e`).join(""));

/** The git reads that locate the one branch a child built, and the commits it adds. */
const locating = (
	branches: ReadonlyArray<string> = [CHILD_BRANCH, "main", "epic/5800"],
	commits: ReadonlyArray<readonly [string, string]> = [[CHILD_TIP, CHILD_MESSAGE]],
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[REV("epic/5800"), okOut(`${EPIC_BASE}\n`)],
	[/^git rev-parse --verify --quiet build\//, okOut(`${CHILD_TIP}\n`)],
	[BRANCHES, okOut(`${branches.join("\n")}\n`)],
	// The child is not integrated here, so its fork point is where the epic branch stands.
	[/^git merge-base /, okOut(`${EPIC_BASE}\n`)],
	[LOG_RANGE, logOf(...commits)],
];

/**
 * An epic lane in the one-PR shape, its machine emitted by `emitMachine` rather than hand-written —
 * a brief arm keyed to a shape the emitter does not produce would pass its own test and refuse the
 * live lane.
 */
const epicLane = (events: ReadonlyArray<readonly [string, string]>) => {
	const emitted = emitMachine(EPIC, "## Dependencies\n\n- phase 1: #5828\n", [
		{number: 5828, state: "open", stateReason: null},
	]);
	if (emitted._tag !== "Emitted") throw new Error(`the epic fixture did not emit: ${emitted._tag}`);
	return fakeFs({
		files: {
			[`${ROOT}/${EPIC}/workflow.json`]: emitted.text,
			[`${ROOT}/${EPIC}/events.jsonl`]:
				events.length === 0
					? null
					: `${events
							.map(([task, event]) =>
								JSON.stringify({
									task,
									event: `${task.toUpperCase()}.${event}`,
									at: "2026-08-17T00:00:00Z",
								}),
							)
							.join("\n")}\n`,
		},
	});
};

/**
 * A non-phoenix entrypoint on purpose: every brief these tests read back is the shape a repo that
 * *installs* fabrika gets, so a path bound back to `packages/fabrika-cli/` fails here rather than in
 * a consuming repo's maiden run (#6012).
 */
const ENTRY = "/checkout/node_modules/@kampus/fabrika-cli/dist/bin.js";

const options = {
	root: ROOT,
	lane: "5751",
	task: null as string | null,
	repo: null as string | null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	entrypoint: {_tag: "Entrypoint", entrypoint: ENTRY} as EntrypointRead,
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
			[PR_CLOSERS, closingPulls()],
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
			[PR_CLOSERS, closingPulls([5790, PR_URL])],
		]);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {
				state: "review",
				shell: "reviewer",
				issue: ISSUE_URL,
				ground: {_tag: "Pull", pr: PR_URL},
			},
		});
	});

	it("briefs the ui-builder shell on a `build:ui` state, still with no PR", async () => {
		const out = await run(lane("5751", ["WIP"], ["ui"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_CLOSERS, closingPulls()],
		]);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {state: "build:ui", shell: "ui-builder", ground: {_tag: "Pull", pr: null}},
		});
	});

	it("briefs the ui-reviewer shell on a `review:ui` state, over the same one PR", async () => {
		const out = await run(lane("5751", ["WIP", "DONE", "PASS"], ["ui"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_CLOSERS, closingPulls([5790, PR_URL])],
		]);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {state: "review:ui", shell: "ui-reviewer", ground: {_tag: "Pull", pr: PR_URL}},
		});
	});

	it("prints a single-issue brief byte for byte — the format's bytes, nothing per dispatch", async () => {
		const out = await run(lane("5751", ["WIP", "DONE"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_CLOSERS, closingPulls([5790, PR_URL])],
		]);

		expect(out.stdout).toBe(
			`## Task\nlane: 5751\nroot: ${resolve(ROOT)}\nfabrika: ${ENTRY}\ntask: issue\nstate: review\nshell: reviewer\n## Ground\nissue: ${ISSUE_URL}\npr: ${PR_URL}\n## Rules\n${RULES}\n`,
		);
	});

	it("carries the driver's lanes root resolved absolute — the shell would resolve a relative one against its own worktree", async () => {
		const out = await run(lane("5751", ["WIP"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_CLOSERS, closingPulls()],
		]);

		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {root: resolve(ROOT)},
		});
	});

	it("prints an absolute root unchanged — resolution is not a rewrite", async () => {
		const absolute = "/elsewhere/checkout/.fabrika/lanes";
		const out = await run(
			fakeFs({
				files: {
					[`${absolute}/5751/workflow.json`]: coderTemplateText(),
					[`${absolute}/5751/events.jsonl`]: `${JSON.stringify({
						task: "issue",
						event: "ISSUE.WIP",
						at: "2026-08-17T00:00:00Z",
					})}\n`,
				},
			}),
			[
				[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
				[PR_CLOSERS, closingPulls()],
			],
			{root: absolute},
		);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({_tag: "Found", value: {root: absolute}});
	});

	it("briefs the shipper on a `ship` state", async () => {
		const out = await run(lane("5751", ["WIP", "DONE", "PASS"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_CLOSERS, closingPulls([5790, PR_URL])],
		]);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {state: "ship", shell: "shipper", ground: {_tag: "Pull", pr: PR_URL}},
		});
	});

	it("carries URLs only — no title, no body, no verdict text", async () => {
		const out = await run(lane("5751", ["WIP", "DONE"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_CLOSERS, closingPulls([5790, PR_URL])],
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
				[PR_CLOSERS, closingPulls()],
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

	it("refuses when this fabrika's own entrypoint could not be resolved — UNKNOWN, never a brief", async () => {
		const out = await run(lane("5751", ["WIP"]), [], {
			entrypoint: {_tag: "Unresolved", reason: "this fabrika's own package root is not on disk"},
		});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("this fabrika's own package root is not on disk");
	});

	it("refuses a resolved entrypoint node cannot run — a binstub reaching the brief is #5679 again", async () => {
		const binstub = "/checkout/node_modules/.bin/fabrika";
		const out = await run(lane("5751", ["WIP"]), [], {
			entrypoint: {_tag: "Entrypoint", entrypoint: binstub},
		});

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain(`"${binstub}" is not node-runnable`);
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
			[PR_CLOSERS, closingPulls([5790, PR_URL], [5791, "https://github.com/o/r/pull/5791"])],
		]);

		expect(out.code).toBe(PR_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain("#5790");
		expect(out.stderr.join("\n")).toContain("#5791");
	});

	it("refuses zero open PRs where the state needs one", async () => {
		const out = await run(lane("5751", ["WIP", "DONE", "PASS"]), [
			[ISSUE_READ, issuePayload(5751, ISSUE_URL)],
			[PR_CLOSERS, closingPulls()],
		]);

		expect(out.code).toBe(PR_AMBIGUOUS);
		expect(out.stdout).toBe("");
	});
});

describe("lane brief on an epic lane", () => {
	const runEpic = async (
		fs: ReturnType<typeof fakeFs>,
		script: ReadonlyArray<readonly [RegExp, ExecResult]>,
		overrides: Partial<typeof options>,
	) => {
		const shell = fakeShell(script);
		const out = await Effect.runPromise(
			Effect.provide(
				runBrief({...options, lane: String(EPIC), ...overrides}),
				Layer.merge(fs.layer, shell.layer),
			),
		);
		return {out, calls: shell.calls};
	};

	it("briefs a child's build on the epic branch, resolving no PR at all", async () => {
		const {out, calls} = await runEpic(
			epicLane([["issue_5828", "WIP"]]),
			[
				[EPIC_CHILD_READ, issuePayload(5828, CHILD_URL)],
				[EPIC_ISSUE_READ, issuePayload(EPIC, EPIC_URL)],
			],
			{task: "issue_5828"},
		);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {
				lane: "5800",
				task: "issue_5828",
				state: "build",
				shell: "builder",
				issue: CHILD_URL,
				ground: {_tag: "Epic", epic: EPIC_URL, branch: "epic/5800"},
			},
		});
		expect(out.stdout).toContain(EPIC_RULES);
		expect(out.stdout).not.toContain("range:");
		expect(calls.some((call) => PR_CLOSERS.test(call))).toBe(false);
		// No child branch exists yet at `build`, so the tree is never read for one.
		expect(calls.some((call) => call.startsWith("git "))).toBe(false);
	});

	const reviewing = (
		script: ReadonlyArray<readonly [RegExp, ExecResult]> = locating(),
	): ReadonlyArray<readonly [RegExp, ExecResult]> => [
		[EPIC_CHILD_READ, issuePayload(5828, CHILD_URL)],
		[EPIC_ISSUE_READ, issuePayload(EPIC, EPIC_URL)],
		...script,
	];

	const atReview = () =>
		epicLane([
			["issue_5828", "WIP"],
			["issue_5828", "DONE"],
		]);

	it("briefs a child's review with the range this tree resolved and the range-verdict contract", async () => {
		const {out, calls} = await runEpic(atReview(), reviewing(), {task: "issue_5828"});

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {
				state: "review",
				shell: "reviewer",
				ground: {
					_tag: "EpicRange",
					branch: "epic/5800",
					range: {base: EPIC_BASE, tip: CHILD_TIP},
				},
			},
		});
		expect(out.stdout).toContain(`range: ${EPIC_BASE}..${CHILD_TIP}`);
		expect(out.stdout).toContain("range-verdict-marker");
		expect(calls.some((call) => PR_CLOSERS.test(call))).toBe(false);
	});

	it("never prints a literal HEAD — the spawned reviewer would re-resolve it in its own worktree", async () => {
		const {out} = await runEpic(atReview(), reviewing(), {task: "issue_5828"});

		expect(out.stdout).not.toContain("HEAD");
	});

	it("refuses a child review when no branch in this tree carries the child's commits", async () => {
		const {out} = await runEpic(atReview(), reviewing(locating(["main", "epic/5800"])), {
			task: "issue_5828",
		});

		expect(out.code).toBe(PROOF_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("no local branch in this tree was cut for #5828");
	});

	it("refuses a child review when several branches carry the child's commits", async () => {
		const {out} = await runEpic(
			atReview(),
			reviewing(locating([CHILD_BRANCH, "build/5828-second-try-deadbeef"])),
			{task: "issue_5828"},
		);

		expect(out.code).toBe(PROOF_AMBIGUOUS);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("build/5828-second-try-deadbeef");
	});

	it("leaves a child review UNKNOWN when the epic branch is not in this tree", async () => {
		const {out} = await runEpic(
			atReview(),
			reviewing([[REV("epic/5800"), errOut("unknown revision")]]),
			{task: "issue_5828"},
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("briefs the epic tail's review on the one PR the run produced", async () => {
		const {out} = await runEpic(
			epicLane([
				["issue_5828", "WIP"],
				["issue_5828", "DONE"],
				["issue_5828", "PASS"],
			]),
			[
				[EPIC_ISSUE_READ, issuePayload(EPIC, EPIC_URL)],
				[PR_CLOSERS, closingPulls([5890, PR_URL])],
			],
			{task: "epic_5800"},
		);

		expect(out.code).toBe(0);
		expect(readBrief(out.stdout)).toMatchObject({
			_tag: "Found",
			value: {
				task: "epic_5800",
				state: "review",
				shell: "reviewer",
				issue: EPIC_URL,
				ground: {_tag: "Tail", pr: PR_URL, epic: EPIC_URL},
			},
		});
		// The tail's brief names where each child's build-deviations disclosure lives (#5903).
		expect(out.stdout).toContain(EPIC_TAIL_RULES);
		expect(out.stdout).not.toContain(EPIC_RULES);
	});

	it("keeps the tail's zero-PR refusal — a run with no PR is a real ambiguity", async () => {
		const {out} = await runEpic(
			epicLane([
				["issue_5828", "WIP"],
				["issue_5828", "DONE"],
				["issue_5828", "PASS"],
			]),
			[
				[EPIC_ISSUE_READ, issuePayload(EPIC, EPIC_URL)],
				[PR_CLOSERS, closingPulls()],
			],
			{task: "epic_5800"},
		);

		expect(out.code).toBe(PR_AMBIGUOUS);
		expect(out.stdout).toBe("");
	});

	it("refuses the tail when several open PRs claim the epic", async () => {
		const {out} = await runEpic(
			epicLane([
				["issue_5828", "WIP"],
				["issue_5828", "DONE"],
				["issue_5828", "PASS"],
			]),
			[
				[EPIC_ISSUE_READ, issuePayload(EPIC, EPIC_URL)],
				[PR_CLOSERS, closingPulls([5890, PR_URL], [5891, "https://github.com/o/r/pull/5891"])],
			],
			{task: "epic_5800"},
		);

		expect(out.code).toBe(PR_AMBIGUOUS);
		expect(out.stderr.join("\n")).toContain("#5891");
	});

	it("refuses a child whose epic issue could not be read — UNKNOWN, never a brief", async () => {
		const {out} = await runEpic(
			epicLane([["issue_5828", "WIP"]]),
			[
				[EPIC_CHILD_READ, issuePayload(5828, CHILD_URL)],
				[EPIC_ISSUE_READ, errOut("gh: Server Error (HTTP 503)")],
			],
			{task: "issue_5828"},
		);

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
	});
});
