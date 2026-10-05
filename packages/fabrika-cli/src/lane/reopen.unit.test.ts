/** The reopen judgement: open, every closer merged, and reopened after the last merge. */
import {describe, expect, it} from "vitest";
import type {CloserState, ReopenFacts} from "../io/pulls.ts";
import {judgeReopen} from "./reopen.ts";

const merged = (number: number, mergedAt: string): CloserState => ({
	number,
	state: "MERGED",
	mergedAt,
});

const facts = (overrides: Partial<ReopenFacts> = {}): ReopenFacts => ({
	state: "OPEN",
	reopenedAt: "2026-10-01T18:00:00Z",
	closers: [merged(7001, "2026-10-01T10:00:00Z")],
	...overrides,
});

describe("judgeReopen", () => {
	it("answers `Reopened` for an open issue reopened after its only closer merged", () => {
		expect(judgeReopen(42, facts())).toEqual({
			_tag: "Reopened",
			pulls: [7001],
			landedAt: "2026-10-01T10:00:00Z",
			reopenedAt: "2026-10-01T18:00:00Z",
		});
	});

	it("measures the reopen against the LAST merge when several closers merged", () => {
		const twice = facts({
			closers: [merged(7001, "2026-10-01T10:00:00Z"), merged(7002, "2026-10-01T20:00:00Z")],
		});

		expect(judgeReopen(42, twice)).toMatchObject({_tag: "NotReopened"});
		expect(judgeReopen(42, {...twice, reopenedAt: "2026-10-02T00:00:00Z"})).toMatchObject({
			_tag: "Reopened",
			pulls: [7001, 7002],
			landedAt: "2026-10-01T20:00:00Z",
		});
	});

	it("leaves a closed-unmerged pull request out of the judgement", () => {
		const verdict = judgeReopen(
			42,
			facts({
				closers: [
					merged(7001, "2026-10-01T10:00:00Z"),
					{number: 7000, state: "CLOSED", mergedAt: null},
				],
			}),
		);

		expect(verdict).toMatchObject({_tag: "Reopened", pulls: [7001]});
	});

	it.each([
		["a closed issue", facts({state: "CLOSED"}), "closed"],
		[
			"an open closing pull request",
			facts({
				closers: [
					merged(7001, "2026-10-01T10:00:00Z"),
					{number: 7003, state: "OPEN", mergedAt: null},
				],
			}),
			"#7003",
		],
		["no merged closer", facts({closers: []}), "no merged pull request"],
		["no reopen on the timeline", facts({reopenedAt: null}), "no reopen"],
		["a reopen before the landing", facts({reopenedAt: "2026-10-01T09:00:00Z"}), "not after"],
		[
			"a merged closer with no merge time",
			facts({closers: [{number: 7001, state: "MERGED", mergedAt: null}]}),
			"no merge time",
		],
	])("answers `NotReopened` for %s, naming why", (_, read, why) => {
		const verdict = judgeReopen(42, read);

		expect(verdict._tag).toBe("NotReopened");
		expect(verdict._tag === "NotReopened" ? verdict.why : "").toContain(why);
	});
});
