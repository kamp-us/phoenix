import {describe, expect, it} from "vitest";
import {SHIPPED_TABLE} from "../config/keys/table.ts";
import type {TimelineFacts, TimelineReference} from "../io/issues.ts";
import type {Instant, LaneRecord} from "../wire/lane-record.ts";
import {
	checkRec,
	dueChecks,
	type Evidence,
	fabrikaNumbersOf,
	isFabrikaWork,
	renderCheck,
	type Signals,
	signalsOf,
	sourceResultOf,
} from "./check.ts";
import type {HeadRow} from "./flags.ts";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

const head = (
	issue: number,
	stage: string | null,
	setAt = ago(20),
	origin: string | null = "bet",
): HeadRow => ({
	group: {_tag: "Single", head: issue},
	stage: stage === null ? null : {name: stage, setter: "someone", setAt},
	size: "S",
	children: 0,
	memberStages: [],
	origin,
});

describe("dueChecks", () => {
	it("takes a row shipped at least the delay ago, and nothing else", () => {
		const due = dueChecks(
			[
				head(3, "shipped", ago(14)),
				head(1, "shipped", ago(30)),
				head(2, "shipped", ago(13)),
				head(4, "bet", ago(30)),
				head(5, "check", ago(30)),
				head(6, null),
			],
			14,
			NOW,
		);

		expect(due.map((check) => check.group.head)).toEqual([1, 3]);
		expect(due[0]?.shippedAt).toBe(ago(30));
	});

	it("takes only bets: a shipped row that ran without a bet never comes back", () => {
		const due = dueChecks(
			[
				head(1, "shipped", ago(30), "bet"),
				head(2, "shipped", ago(30), "driver pick"),
				head(3, "shipped", ago(30), "hand-start"),
				head(4, "shipped", ago(30), null),
			],
			14,
			NOW,
		);

		expect(due.map((check) => check.group.head)).toEqual([1]);
	});
});

const ref = (over: Partial<TimelineReference> & {number: number}): TimelineReference => ({
	title: `Issue ${over.number}`,
	isPullRequest: false,
	open: true,
	merged: false,
	labels: [],
	createdAt: ago(5),
	...over,
});

const facts = (references: ReadonlyArray<TimelineReference>, reopenedAt: string[] = []) =>
	({references, reopenedAt}) satisfies TimelineFacts;

describe("signalsOf", () => {
	const check = {
		group: {_tag: "Epic", head: 10, members: [11]} as const,
		shippedAt: ago(14),
	};

	it("counts issues filed since ship that mention a PR, reverts, reopens and open follow-ups", () => {
		const signals = signalsOf({
			check,
			prs: [100, 101],
			prTimelines: new Map([
				[
					100,
					facts([
						ref({number: 20, labels: ["bug"]}),
						ref({number: 21, createdAt: ago(20)}),
						ref({number: 11}),
						ref({number: 30, title: "Revert #100", isPullRequest: true}),
						ref({number: 31, title: "Follow-up fix", isPullRequest: true}),
					]),
				],
				[101, facts([ref({number: 20, labels: ["bug"]}), ref({number: 22, open: false})])],
			]),
			issueTimelines: new Map([
				[10, facts([], [ago(20)])],
				[11, facts([], [ago(2)])],
			]),
			followUps: [11],
		});

		expect(signals).toEqual({
			prs: [100, 101],
			mentions: [
				{number: 20, title: "Issue 20", bug: true, open: true},
				{number: 22, title: "Issue 22", bug: false, open: false},
			],
			reverts: [{number: 30, title: "Revert #100", merged: false}],
			reopened: [11],
			followUps: [11],
		} satisfies Signals);
	});
});

const lane = (terminalDaysAgo: number, outcome: string, usd: number | null): LaneRecord => {
	const at = ago(terminalDaysAgo) as Instant;
	return {
		issue: 1,
		outcome,
		startedAt: at,
		terminalAt: at,
		builds: 1,
		reviews: 1,
		parks: [],
		spent: usd === null ? {_tag: "Unmeasured", reason: "no rate card"} : {_tag: "Measured", usd},
		origin: "bet",
		waiting: {_tag: "None"},
		prs: [],
		log: [],
	} as LaneRecord;
};

describe("fabrika's numbers", () => {
	it("compares the delay before ship with the time since", () => {
		const records = new Map([
			[1, [lane(20, "complete", 10), lane(18, "tripped", 30)]],
			[2, [lane(5, "complete", 10), lane(3, "complete", 6)]],
		]);
		const numbers = fabrikaNumbersOf(records, ago(14), 14, NOW);

		expect(numbers).toEqual({
			days: 14,
			before: {lanes: 2, landed: 1, spentUsd: 40, unmeasured: 0},
			since: {lanes: 2, landed: 2, spentUsd: 16, unmeasured: 0},
		});
		const body = renderCheck({...EVIDENCE, fabrika: numbers});
		expect(body).toContain(
			"- Land rate: 50% (1 of 2 lanes) in the 14 days before it shipped, 100% (2 of 2 lanes) since, up 50 points.",
		);
		expect(body).toContain(
			"- Spend: $20 a lane ($40 over 2 lanes) before, $8 a lane ($16 over 2 lanes) since, down $12.",
		);
	});

	it("names spend it could not measure instead of a per-lane figure", () => {
		const numbers = fabrikaNumbersOf(new Map([[1, [lane(3, "complete", null)]]]), ago(14), 14, NOW);
		const body = renderCheck({...EVIDENCE, fabrika: numbers});

		expect(body).toContain(
			"- Spend: no lane ended before, $0 measured, 1 lane not measured since.",
		);
	});

	it("is fabrika work only when a declared label is on the issue", () => {
		const settings = {
			...SHIPPED_TABLE,
			fabrikaShare: {...SHIPPED_TABLE.fabrikaShare, labels: ["fab"]},
		};

		expect(isFabrikaWork(["fab", "p1"], settings)).toBe(true);
		expect(isFabrikaWork(["p1"], settings)).toBe(false);
		expect(isFabrikaWork(["fab"], SHIPPED_TABLE)).toBe(false);
	});
});

const bytes = (text: string) => new TextEncoder().encode(text);
const SOURCE = {name: "metrics", command: ["./m"] as const, timeoutSeconds: 9};

describe("sourceResultOf", () => {
	it("keeps the output of a source that exited 0, and says when it was cut", () => {
		expect(
			sourceResultOf(SOURCE, {
				_tag: "Ran",
				exitCode: 0,
				timedOut: false,
				stdout: bytes("  p95 1.2s\n"),
				stderr: bytes(""),
				truncated: true,
			}),
		).toEqual({_tag: "Output", name: "metrics", text: "p95 1.2s", truncated: true});
	});

	it("reports a non-zero exit, a timeout and a source that would not start", () => {
		const ran = {stdout: bytes(""), truncated: false} as const;
		expect(
			sourceResultOf(SOURCE, {
				_tag: "Ran",
				exitCode: 3,
				timedOut: false,
				stderr: bytes("\nboom\nmore"),
				...ran,
			}),
		).toEqual({_tag: "Failed", name: "metrics", reason: "exited 3: boom"});
		expect(
			sourceResultOf(SOURCE, {
				_tag: "Ran",
				exitCode: null,
				timedOut: true,
				stderr: bytes(""),
				...ran,
			}),
		).toEqual({_tag: "Failed", name: "metrics", reason: "timed out after 9s"});
		expect(sourceResultOf(SOURCE, {_tag: "Unstartable", reason: "ENOENT"})).toEqual({
			_tag: "Failed",
			name: "metrics",
			reason: "could not start: ENOENT",
		});
	});
});

const EVIDENCE: Evidence = {
	issue: 10,
	shippedAt: "2026-09-17T08:00:00.000Z",
	success: "exports finish under 2s",
	signals: {prs: [], mentions: [], reverts: [], reopened: [], followUps: []},
	fabrika: null,
	sources: [],
};

describe("renderCheck", () => {
	it("says there is no PR to read signals off when the lanes name none", () => {
		const body = renderCheck(EVIDENCE);

		expect(body).toContain("**Check: did #10 work?** It shipped on 2026-09-17.");
		expect(body).toContain("- Pull requests: its lane records name none");
		expect(body).toContain("- Reverts: none.");
		expect(body.trimEnd().endsWith("<!-- fabrika:outcome-check issue=10 -->")).toBe(true);
	});

	it("fences source output longer than any backtick run inside it", () => {
		const body = renderCheck({
			...EVIDENCE,
			sources: [{_tag: "Output", name: "log", text: "a ``` b", truncated: false}],
		});

		expect(body).toContain("````\na ``` b\n````");
	});
});

describe("checkRec", () => {
	it("keeps a long Success line short", () => {
		const rec = checkRec({...EVIDENCE, success: "x".repeat(300)});

		expect(rec.length).toBeLessThan(260);
		expect(rec).toContain("…");
		expect(rec).toMatch(/^did it work\? Set Outcome\. /);
	});
});
