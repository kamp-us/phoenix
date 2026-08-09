import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {LINKED} from "../build/fixtures.test-support.ts";
import {errOut, fakeFs, fakeShell, okOut, once} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {
	BARE_AT_PATH,
	LEAKED_PATH,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {CLAIMED, childIssue, DIR, env, epic, subIssues} from "./fixtures.test-support.ts";
import {
	type ChildRecord,
	manifestPath,
	renderManifest,
	renderRunRecord,
	runJsonPath,
} from "./run.ts";
import {runSupersede} from "./supersede-verb.ts";

const SUBS = /^gh api --paginate repos\/o\/r\/issues\/4300\/sub_issues/;
const CHILD = /^gh api repos\/o\/r\/issues\/4288$/;
const COMMENT = /^gh api --method POST repos\/o\/r\/issues\/4288\/comments/;
const UNLINK = /^gh api --method DELETE repos\/o\/r\/issues\/4300\/sub_issue /;
const CLOSE = /^gh api --method PATCH repos\/o\/r\/issues\/4288/;

const RUN_JSON = renderRunRecord({
	epic: 4300,
	run: "4300-c1a4d6f8",
	mode: "re-plan",
	cycleDoc: "present",
	bodyDigest: bodyDigest("An epic brief about the moderation queue.\n"),
});

const record = (number: number, mintedThisRun: boolean): ChildRecord => ({
	number,
	id: number * 10,
	title: `child ${number}`,
	type: "type:feature",
	priority: "p1",
	readyFor: "agent",
	stories: [1],
	containment: "flag",
	linked: true,
	mintedThisRun,
});

const files = (...records: ReadonlyArray<ChildRecord>) => ({
	[runJsonPath(DIR)]: RUN_JSON,
	[manifestPath(DIR)]: renderManifest(records),
});

const COMMENTED = okOut(
	JSON.stringify({id: 5230661234, html_url: "https://github.com/o/r/issues/4288#c"}),
);

/** The three legs and the reads around them; `once` lets each read differ before and after. */
const happy = (
	overrides: {
		comment?: ExecResult;
		unlink?: ExecResult;
		close?: ExecResult;
		after?: ExecResult;
		afterSubs?: ExecResult;
	} = {},
): ReadonlyArray<readonly [RegExp, ExecResult]> => [
	[/^gh api repos\/o\/r\/issues\/4300$/, epic()],
	[/^git rev-parse --path-format=absolute/, LINKED],
	...CLAIMED,
	[once(SUBS), subIssues({number: 4288, id: 42880})],
	[once(CHILD), childIssue({number: 4288})],
	[COMMENT, overrides.comment ?? COMMENTED],
	[UNLINK, overrides.unlink ?? okOut("{}")],
	[CLOSE, overrides.close ?? okOut("{}")],
	[
		CHILD,
		overrides.after ?? childIssue({number: 4288, state: "closed", stateReason: "not_planned"}),
	],
	[SUBS, overrides.afterSubs ?? okOut("[]")],
];

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]> = happy(),
	fsFiles: Readonly<Record<string, string | null>> = files(record(4288, false)),
	options: {child?: number; reason?: string} = {},
) => {
	const shell = fakeShell(script);
	const fs = fakeFs({files: fsFiles});
	return Effect.runPromise(
		Effect.provide(
			runSupersede({
				number: 4300,
				child: options.child ?? 4288,
				reason: options.reason ?? "folded into the loader slice",
				repo: null,
				env,
			}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	).then((outcome) => ({outcome, calls: shell.calls}));
};

describe("runSupersede", () => {
	it("comments, unlinks, closes, and proves the result", async () => {
		const {outcome} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "superseded",
			epic: 4300,
			child: 4288,
			comment: 5230661234,
			unlinked: true,
			state: "closed",
		});
	});

	/**
	 * Closing before unlinking leaves a closed issue still counted as a sub-issue, which the gate reads
	 * as a child in scope that can never carry a live assignee (#5026).
	 */
	it("unlinks before it closes, and journals before either", async () => {
		const {calls} = await run();
		const order = calls.filter(
			(line) => COMMENT.test(line) || UNLINK.test(line) || CLOSE.test(line),
		);
		expect(
			order.map((line) =>
				COMMENT.test(line) ? "comment" : UNLINK.test(line) ? "unlink" : "close",
			),
		).toEqual(["comment", "unlink", "close"]);
	});

	it("unlinks on the child's id, not its number", async () => {
		const {calls} = await run();
		expect(calls.find((line) => UNLINK.test(line))).toContain("sub_issue_id=42880");
	});

	it("refuses a child this run minted — a re-plan does not retire its own work", async () => {
		const {outcome, calls} = await run(happy(), files(record(4288, true)));
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger supersede: #4288 was minted by this run — refusing to supersede a child of the current plan.",
		);
		expect(calls.some((line) => COMMENT.test(line))).toBe(false);
	});

	it("refuses a child that is not this epic's sub-issue", async () => {
		const {outcome} = await run(
			[
				[/^gh api repos\/o\/r\/issues\/4300$/, epic()],
				[/^git rev-parse --path-format=absolute/, LINKED],
				...CLAIMED,
				[SUBS, subIssues({number: 4301, id: 43010})],
			],
			files(),
		);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toBe("ledger supersede: #4288 is not a sub-issue of #4300.");
	});

	it("refuses a child that is already closed", async () => {
		const {outcome} = await run([
			[/^gh api repos\/o\/r\/issues\/4300$/, epic()],
			[/^git rev-parse --path-format=absolute/, LINKED],
			...CLAIMED,
			[SUBS, subIssues({number: 4288, id: 42880})],
			[CHILD, childIssue({number: 4288, state: "closed"})],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("refuses a reason carrying a machine-local path, masked", async () => {
		const {outcome, calls} = await run(happy(), files(record(4288, false)), {
			reason: "see /Users/someone/notes.md",
		});
		expect(outcome.code).toBe(LEAKED_PATH);
		expect(outcome.stderr.join("\n")).toContain("/Users/<redacted>");
		expect(calls).toEqual([]);
	});

	it("refuses a reason that is a bare @ path reference", async () => {
		const {outcome} = await run(happy(), files(record(4288, false)), {reason: "@some/path.md"});
		expect(outcome.code).toBe(BARE_AT_PATH);
	});

	/** The journal is posted first so the reason survives even if a later leg fails. */
	it("reports how many legs landed when one could not be proven", async () => {
		const {outcome} = await run(happy({unlink: errOut("gh: Bad Gateway (HTTP 502)")}));
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.at(-1)).toBe(
			"ledger supersede: wrote 1 of 3 legs on #4288 and could not prove the rest — the child is UNKNOWN.",
		);
	});

	it("refuses when the child does not read back closed", async () => {
		const {outcome} = await run(happy({after: childIssue({number: 4288, state: "open"})}));
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("refuses when the child reads back closed for the wrong reason", async () => {
		const {outcome} = await run(
			happy({after: childIssue({number: 4288, state: "closed", stateReason: "completed"})}),
		);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("refuses when the child is still linked after the unlink", async () => {
		const {outcome} = await run(happy({afterSubs: subIssues({number: 4288, id: 42880})}));
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("refuses when the sub-issue list could not be read", async () => {
		const {outcome} = await run([
			[/^gh api repos\/o\/r\/issues\/4300$/, epic()],
			[/^git rev-parse --path-format=absolute/, LINKED],
			...CLAIMED,
			[SUBS, errOut("gh: Bad Gateway (HTTP 502)")],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
