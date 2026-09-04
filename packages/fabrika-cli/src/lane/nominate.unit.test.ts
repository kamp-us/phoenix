/**
 * The shared candidate nominator, and the deadlock it was extracted to end (#6179): `lane prove`
 * proving a `DONE` off a `Part of #N` PR that `lane brief` then refused to see.
 */
import {resolve} from "node:path";
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import type {EntrypointRead} from "../delegate/entrypoint.ts";
import {fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {RULES} from "../wire/lane-brief.ts";
import {runBrief} from "./brief-verb.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";
import {nominatePulls} from "./nominate.ts";
import {tracePulls} from "./prove.ts";
import {runProve} from "./prove-verb.ts";

const ROOT = ".fabrika/lanes";
const ISSUE = 5751;
const PR = 5790;
const PR_URL = `https://github.com/o/r/pull/${PR}`;
const ISSUE_URL = `https://github.com/o/r/issues/${ISSUE}`;
const ENTRY = "/checkout/node_modules/@kampus/fabrika-cli/dist/bin.js";

const CLOSERS = /^POST .*\/graphql$/;
const SEARCH = /^GET .*\/search\/issues\?/;
const PULL = new RegExp(`^GET .*/repos/o/r/pulls/${PR}$`);
const ISSUE_READ = new RegExp(`^GET .*/repos/o/r/issues/${ISSUE}$`);

const served = (payload: unknown): HttpReply => ({status: 200, body: JSON.stringify(payload)});

const closingEdge = (...numbers: ReadonlyArray<number>): HttpReply =>
	served({
		data: {
			repository: {
				issue: {
					closedByPullRequestsReferences: {
						pageInfo: {hasNextPage: false, endCursor: null},
						nodes: numbers.map((number) => ({
							number,
							url: `https://github.com/o/r/pull/${number}`,
							state: "OPEN",
						})),
					},
				},
			},
		},
	});

const nominatedBy = (...numbers: ReadonlyArray<number>): HttpReply =>
	served({total_count: numbers.length, items: numbers.map((number) => ({number}))});

/** The lane-5981 / lane-6610 shape: an open PR that links the issue without closing it. */
const partOfPull = served({
	number: PR,
	state: "open",
	head: {sha: "6ba0a4e2ff5e4f6b9e2b0e4b1f7cf50b7b6a3d21"},
	base: {ref: "main"},
	body: `Part of #${ISSUE}.\n\n## Deviations\nNone.\n`,
	changed_files: 1,
	comments: 0,
	html_url: PR_URL,
});

const issuePayload = served({
	number: ISSUE,
	title: "the two verbs disagree about which PR links the lane",
	body: "## What is wrong\n\nThe lane deadlocks at review.",
	state: "open",
	labels: [{name: "type:bug"}],
	html_url: ISSUE_URL,
});

/** One board, three ways of nominating the same PR — the fixture the two verbs have to agree over. */
const shapes: ReadonlyArray<readonly [string, ReadonlyArray<Scripted>]> = [
	[
		"closing-edge-only",
		[
			[CLOSERS, closingEdge(PR)],
			[SEARCH, nominatedBy()],
			[PULL, partOfPull],
		],
	],
	[
		"body-search-only",
		[
			[CLOSERS, closingEdge()],
			[SEARCH, nominatedBy(PR)],
			[PULL, partOfPull],
		],
	],
	[
		"both",
		[
			[CLOSERS, closingEdge(PR)],
			[SEARCH, nominatedBy(PR)],
			[PULL, partOfPull],
		],
	],
];

const laneAt = (...events: ReadonlyArray<string>) =>
	fakeFs({
		files: {
			[`${ROOT}/${ISSUE}/workflow.json`]: coderTemplateText(),
			[`${ROOT}/${ISSUE}/events.jsonl`]: events
				.map(
					(event, index) =>
						`${JSON.stringify({
							task: "issue",
							event: `ISSUE.${event}`,
							at: `2026-08-21T0${index}:00:00Z`,
						})}\n`,
				)
				.join(""),
		},
	});

describe("the shared candidate nominator", () => {
	for (const [shape, script] of shapes) {
		it(`nominates the same one candidate from a ${shape} board`, async () => {
			const nomination = await Effect.runPromise(
				Effect.provide(nominatePulls("o/r", ISSUE), fakeSeams(script).layer),
			);

			expect(nomination).toMatchObject({_tag: "Nominated"});
			if (nomination._tag !== "Nominated") throw new Error("unreachable");
			expect(nomination.pulls.map((pull) => pull.number)).toEqual([PR]);
			expect(tracePulls(ISSUE, nomination.pulls)).toEqual({_tag: "One", pr: PR});
			expect(nomination.pulls[0]?.htmlUrl).toBe(PR_URL);
		});
	}

	it("is UNKNOWN rather than an empty set when the body search cannot be read", async () => {
		const nomination = await Effect.runPromise(
			Effect.provide(
				nominatePulls("o/r", ISSUE),
				fakeSeams([
					[CLOSERS, closingEdge()],
					[SEARCH, {status: 502, body: '{"message":"Bad gateway"}'}],
				]).layer,
			),
		);

		expect(nomination._tag).toBe("Unreadable");
	});
});

describe("the `Part of #N` sequence that used to deadlock (#6179)", () => {
	/** The one board both verbs read, with the PR linking the issue through its body alone. */
	const board: ReadonlyArray<Scripted> = [
		[CLOSERS, closingEdge()],
		[SEARCH, nominatedBy(PR)],
		[PULL, partOfPull],
		[ISSUE_READ, issuePayload],
	];

	it("proves the DONE, then briefs the reviewer on the same PR — no exit-20 refusal in between", async () => {
		const proven = await Effect.runPromise(
			Effect.provide(
				runProve({
					root: ROOT,
					lane: String(ISSUE),
					event: "DONE",
					task: null,
					classes: null,
					pr: null,
					repo: null,
					cwd: "/repo",
					env: {CLAUDE_PIPELINE_REPO: "o/r"},
				}),
				Layer.merge(laneAt("WIP").layer, fakeSeams(board).layer),
			),
		);

		expect(proven.code).toBe(0);
		expect(JSON.parse(proven.stdout)).toMatchObject({
			proof: "proven",
			evidence: {kind: "open-pull", pr: PR},
		});

		const briefed = await Effect.runPromise(
			Effect.provide(
				runBrief({
					root: ROOT,
					lane: String(ISSUE),
					task: null,
					repo: null,
					env: {CLAUDE_PIPELINE_REPO: "o/r"},
					entrypoint: {_tag: "Entrypoint", entrypoint: ENTRY} as EntrypointRead,
				}),
				Layer.merge(laneAt("WIP", "DONE").layer, fakeSeams(board).layer),
			),
		);

		expect(briefed.code).toBe(0);
		expect(briefed.stdout).toBe(
			`## Task\nlane: ${ISSUE}\nroot: ${resolve(ROOT)}\nfabrika: ${ENTRY}\ntask: issue\nstate: review\nshell: reviewer\n## Ground\nissue: ${ISSUE_URL}\npr: ${PR_URL}\n## Rules\n${RULES}\n`,
		);
	});

	it("carries the same lane on to its shipper — a non-closing PR is the partial flow, not a defect", async () => {
		const briefed = await Effect.runPromise(
			Effect.provide(
				runBrief({
					root: ROOT,
					lane: String(ISSUE),
					task: null,
					repo: null,
					env: {CLAUDE_PIPELINE_REPO: "o/r"},
					entrypoint: {_tag: "Entrypoint", entrypoint: ENTRY} as EntrypointRead,
				}),
				Layer.merge(laneAt("WIP", "DONE", "PASS").layer, fakeSeams(board).layer),
			),
		);

		expect(briefed.code).toBe(0);
		expect(briefed.stdout).toContain("shell: shipper");
		expect(briefed.stdout).toContain(`pr: ${PR_URL}`);
	});
});
