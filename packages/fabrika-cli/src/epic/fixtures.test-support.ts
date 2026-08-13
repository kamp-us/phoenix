/**
 * The canned world the `epic` verb tests run against: one epic, two slices, one lane.
 *
 * The values are the sibling contracts' worked example — epic #4300, slices C1/C2, run
 * `4300-c1a4d6f8` — so a test that drifts from the contract's own numbers is visible at a glance.
 */
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {type LedgerLine, renderLine} from "./ledger.ts";
import type {RunPlan} from "./run.ts";

export const EPIC = 4300;
export const NONCE = "c1a4d6f8";
export const LANE_UUID = "c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d";
export const SESSION = "s-2ee1";
export const RUN = `${EPIC}-${NONCE}`;
export const ROOT = "/repo/trees/lane-a";
export const DIR = `${ROOT}/.fabrika-epic/${RUN}`;
export const LEDGER = `${DIR}/ledger.jsonl`;
export const PLAN = `${DIR}/plan.json`;
export const BRANCH_NAME = `build/${EPIC}-totals-rework-${NONCE}`;
export const GIT_DIR = `${ROOT}/.git`;

export const BASE = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
export const LANDED = "8c1f2a9d3b7e4a199c2d5e8f0a1b2c3d4e5f6a7b";

export const ENV = {
	CLAUDE_PIPELINE_REPO: "o/r",
	CLAUDE_CODE_SESSION_ID: SESSION,
} as Record<string, string | undefined>;

/** Command patterns every `epic` verb test scripts, named once. */
export const REV_PARSE = /^git rev-parse --path-format=absolute/;
export const BRANCH = /^git rev-parse --abbrev-ref HEAD$/;
export const HEAD = /^git rev-parse HEAD$/;
export const STATUS = /^git status --porcelain$/;
export const COMMENTS = /^gh api --paginate repos\/o\/r\/issues\/4300\/comments/;
export const PERM = /^gh api repos\/o\/r\/collaborators\/agent\/permission/;
export const EPIC_ISSUE = /^gh api repos\/o\/r\/issues\/4300$/;
export const ANCESTOR = /^git merge-base --is-ancestor/;

export const GIT_DIRS = okOut([GIT_DIR, ROOT].join("\n"));
export const ON_LANE = okOut(`${BRANCH_NAME}\n`);
export const MINE = okOut(
	JSON.stringify([
		{
			id: 1,
			body: `build-claim: build:${SESSION}:${LANE_UUID} · 2026-08-09T00:00:00Z`,
			user: {login: "agent"},
			created_at: "2026-08-09T00:00:00Z",
		},
	]),
);
export const WRITE = okOut("write\n");

export const EPIC_BODY = `Totals logic is duplicated; extract one module, then fix the rounding defect.

## Slices
- C1: extract the totals module — #4301
- C2: half-cent rounding fix — #4302

## Dependencies
- phase 1: #4301
- phase 2: #4302
`;

export const CRITERIA_BODY = `### Acceptance criteria
- [ ] cart and invoice render through one totals module
- [ ] no behavior change: existing totals tests pass unmodified
`;

export const issueJson = (overrides: Record<string, unknown> = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: EPIC,
			title: "checkout totals rework",
			body: EPIC_BODY,
			state: "open",
			labels: [{name: "type:epic"}, {name: "status:triaged"}],
			html_url: "https://github.com/o/r/issues/4300",
			milestone: null,
			state_reason: null,
			...overrides,
		}),
	);

export const childJson = (number: number, title: string): ExecResult =>
	issueJson({number, title, body: CRITERIA_BODY, labels: [{name: "type:feature"}]});

export const PLAN_RECORD: RunPlan = {
	epic: EPIC,
	run: RUN,
	slices: [
		{id: "C1", issue: 4301, title: "extract the totals module", criteria: "found"},
		{id: "C2", issue: 4302, title: "half-cent rounding fix", criteria: "found"},
	],
	order: ["C1", "C2"],
};

export const planFile = (plan: RunPlan = PLAN_RECORD): string => `${JSON.stringify(plan)}\n`;

/** A ledger from partial lines, with `seq` and `at` filled in so a test states only what it means. */
export const ledgerOf = (
	...rows: ReadonlyArray<Partial<LedgerLine> & Pick<LedgerLine, "event">>
): string =>
	rows
		.map((row, index) =>
			renderLine({
				seq: index + 1,
				at: "2026-08-09T00:00:00Z",
				slice: null,
				detail: null,
				sha: null,
				...row,
			}),
		)
		.join("");

/** The marker `epic verdict` records, as this run's ledger carries it. */
export const verdictMarkerFor = (
	slice: string,
	polarity: "PASS" | "FAIL",
	sha: string,
	clause: string,
): string => `slice:${slice}: ${polarity} @ ${sha} — ${clause}`;
