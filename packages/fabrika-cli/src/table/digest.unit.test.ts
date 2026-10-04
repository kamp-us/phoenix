/**
 * The digest's report and message: which issues it lists, in what order, and what each tool is sent.
 */
import {describe, expect, it} from "vitest";
import type {ResponseTargets} from "../config/keys/boards.ts";
import type {ListedIssue} from "../io/issues.ts";
import {type DigestReport, digestOf, MESSAGE_LIMIT, payloadOf, renderDigest} from "./digest.ts";
import {pastTargetOf} from "./flags.ts";

const NOW = new Date("2026-10-03T12:00:00.000Z");

const hoursAgo = (hours: number): string =>
	new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const issue = (
	number: number,
	waited: number,
	labels: ReadonlyArray<string>,
	over: Partial<ListedIssue> = {},
): ListedIssue => ({
	number,
	title: `Issue ${number}`,
	body: "",
	labels,
	author: "octo-owner",
	association: "MEMBER",
	createdAt: hoursAgo(waited),
	...over,
});

const TARGETS: ResponseTargets = {
	byLabel: [
		{name: "4h", hours: 4, labels: ["p0"]},
		{name: "1 day", hours: 24, labels: ["p1"]},
	],
	otherwise: {name: "3 days", hours: 72},
};

const BOTH = {sections: ["triage", "on-call"] as const, triageTargetHours: 24};

const WHERE = {
	repo: "acme/widgets",
	serverUrl: "https://git.example.test",
	tool: "discord",
} as const;

describe("the triage section", () => {
	const open = [
		issue(1, 30, ["status:needs-triage"]),
		issue(2, 100, []),
		issue(3, 23, ["status:needs-triage"]),
		issue(4, 500, ["status:triaged", "type:feature"]),
	];

	it("lists every untriaged or unlabeled issue past the target, oldest first", () => {
		const report = digestOf({now: NOW, open, settings: BOTH, onCall: null});

		expect(report.sections).toEqual([
			{
				section: "triage",
				late: [
					{
						issue: 2,
						title: "Issue 2",
						target: "24 hours",
						hours: 24,
						since: hoursAgo(100),
						waitedHours: 100,
					},
					{
						issue: 1,
						title: "Issue 1",
						target: "24 hours",
						hours: 24,
						since: hoursAgo(30),
						waitedHours: 30,
					},
				],
			},
		]);
	});

	it("measures against the target the repository configured", () => {
		const report = digestOf({
			now: NOW,
			open,
			settings: {sections: ["triage"], triageTargetHours: 20},
			onCall: null,
		});

		expect(report.sections[0]?.late.map((late) => late.issue)).toEqual([2, 1, 3]);
	});
});

describe("the on-call section", () => {
	const open = [
		issue(10, 5, ["type:bug", "p0"]),
		issue(11, 3, ["type:bug", "p0"]),
		issue(12, 30, ["type:bug", "p1"]),
		issue(13, 60, ["type:bug"]),
		issue(14, 900, ["type:bug"]),
	];
	const items = open.map(({number, labels, createdAt}) => ({issue: number, labels, createdAt}));
	const BOARD_MADE = hoursAgo(100);

	it("lists every open on-call item past the target its labels pick, exactly as pastTargetOf judges it", () => {
		const report = digestOf({
			now: NOW,
			open,
			settings: {sections: ["on-call"], triageTargetHours: 24},
			onCall: {targets: TARGETS, boardCreatedAt: BOARD_MADE, open: items},
		});
		const late = report.sections[0]?.late ?? [];

		expect(late.map((one) => [one.issue, one.target, one.waitedHours, one.since])).toEqual([
			[14, "3 days", 100, BOARD_MADE],
			[12, "1 day", 30, hoursAgo(30)],
			[10, "4h", 5, hoursAgo(5)],
		]);
		expect(late.map(({title: _title, ...judged}) => ({_tag: "PastTarget", ...judged}))).toEqual(
			items
				.flatMap((item) => pastTargetOf(item, TARGETS, BOARD_MADE, NOW) ?? [])
				.sort((a, b) => Date.parse(a.since) - Date.parse(b.since)),
		);
	});

	it("is not asked when no boards block gives an issue a response target", () => {
		const report = digestOf({now: NOW, open, settings: BOTH, onCall: null});

		expect(report.notAsked).toEqual(["on-call"]);
		expect(report.sections.map((section) => section.section)).toEqual(["triage"]);
	});
});

describe("the message", () => {
	const report = digestOf({
		now: NOW,
		open: [issue(1, 30, []), issue(10, 5, ["type:bug", "p0"])],
		settings: BOTH,
		onCall: {
			targets: TARGETS,
			boardCreatedAt: hoursAgo(1000),
			open: [{issue: 10, labels: ["type:bug", "p0"], createdAt: hoursAgo(5)}],
		},
	});

	it("names each issue, its target and how long it has waited", () => {
		expect(renderDigest(report, WHERE)).toBe(
			[
				"acme/widgets: 2 issues past their response target",
				"Waiting for triage (1):",
				"- #1 Issue 1: target 24 hours, waited 30 hours. https://git.example.test/acme/widgets/issues/1",
				"On-call, past target (1):",
				"- #10 Issue 10: target 4h, waited 5 hours. https://git.example.test/acme/widgets/issues/10",
			].join("\n"),
		);
	});

	it("says so when nothing is past its target", () => {
		const clear: DigestReport = {sections: [{section: "triage", late: []}], notAsked: []};

		expect(renderDigest(clear, WHERE)).toBe("acme/widgets: nothing is past its response target.");
	});

	it("stays inside the limit and counts the lines it dropped", () => {
		const many = digestOf({
			now: NOW,
			open: Array.from({length: 60}, (_, index) =>
				issue(index + 1, 100 + index, [], {title: "x".repeat(200)}),
			),
			settings: BOTH,
			onCall: null,
		});
		const text = renderDigest(many, WHERE);
		const shown = text.split("\n").filter((line) => line.startsWith("- ")).length;

		expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
		expect(shown).toBeGreaterThan(0);
		expect(text).toContain("Waiting for triage (60):");
		expect(text).toContain(`…and ${60 - shown} more not shown.`);
	});

	it("escapes Slack's control characters so a title starts no link or mention", () => {
		const hostile = digestOf({
			now: NOW,
			open: [issue(1, 30, [], {title: "<!channel> a & b"})],
			settings: BOTH,
			onCall: null,
		});

		expect(renderDigest(hostile, {...WHERE, tool: "slack"})).toContain(
			"#1 &lt;!channel&gt; a &amp; b:",
		);
	});
});

describe("the payload", () => {
	it("is Slack's `text`, and Discord's `content` with no mention parsed and no link preview", () => {
		expect(payloadOf("slack", "hello")).toEqual({text: "hello"});
		expect(payloadOf("discord", "hello")).toEqual({
			content: "hello",
			allowed_mentions: {parse: []},
			flags: 4,
		});
	});
});
