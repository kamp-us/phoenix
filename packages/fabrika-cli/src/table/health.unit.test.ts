/**
 * The status update prep renders for a table, and the marker that keys it on the table day.
 */
import {describe, expect, it} from "vitest";
import {SHIPPED_APPETITE_SIZES} from "../config/keys/appetite-sizes.ts";
import {SHIPPED_TABLE} from "../config/keys/table.ts";
import {flagsOf, NOT_ASKED, type ShareWeek} from "./flags.ts";
import {flagCount, type Health, healthMarker, postedFor, renderHealth} from "./health.ts";
import {parseTableDay, type TableDay} from "./table-day.ts";

const day = (text: string): TableDay => parseTableDay(text) as TableDay;

const TABLE = day("2026-09-28");

describe("renderHealth", () => {
	const quiet: Health = {
		lanes: 0,
		landed: 0,
		staleLanes: 0,
		spentUsd: 0,
		unmeasuredLanes: 0,
		founderLanes: 0,
		outside: {count: 0, kinds: {}, spentUsd: 0, unmeasured: 0},
		continuing: 0,
		flaggedBets: 0,
		inbox: 1,
		unread: [],
	};

	it("says a week with no lane in words, never as a zero rate", () => {
		const update = renderHealth(quiet, TABLE, false);

		expect(update.body).toContain("- Land rate: no lane ended last week");
		expect(update.body).toContain("- Needed a founder: no lane ended last week");
		expect(update.body).toContain("- Inbox: 1 open issue with no labels");
		expect(update.status).toBe("ON_TRACK");
	});

	it("names spend it could not measure, and marks the update with its table day", () => {
		const update = renderHealth(
			{...quiet, lanes: 2, spentUsd: 10, unmeasuredLanes: 1},
			TABLE,
			true,
		);

		expect(update.body).toContain("- Spend: $10 measured, 1 lane not measured");
		expect(update.status).toBe("AT_RISK");
		expect(update.body).toContain("<!-- fabrika:table-health table-day=2026-09-28 -->");
		expect(update.body).toContain("**Table notes, week of Sep 28**");
		expect(update).toMatchObject({startDate: "2026-09-28", targetDate: "2026-10-05"});
		expect(postedFor([{id: "SU", body: update.body, startDate: null}], TABLE)).toBe(true);
		expect(
			postedFor([{id: "SU", body: healthMarker(day("2026-09-21")), startDate: null}], TABLE),
		).toBe(false);
	});

	it("never posts ON_TRACK over a flag check it could not read, and names the check", () => {
		const update = renderHealth(
			{...quiet, unread: [{check: "over-size", issue: 10, reason: "1 lane(s) went unmeasured"}]},
			TABLE,
			false,
		);

		expect(update.status).toBe("AT_RISK");
		expect(update.body).toContain("- Could not check: over-size on #10");
	});

	it("is on track with the fabrika-share check off, and at risk when a labelled share went unread", () => {
		const report = (share: ShareWeek) =>
			flagsOf({
				settings: SHIPPED_TABLE,
				sizes: SHIPPED_APPETITE_SIZES,
				now: new Date("2026-09-27T12:00:00.000Z"),
				rows: [],
				records: new Map(),
				deciders: {_tag: "Roster", logins: new Set()},
				campaigns: {_tag: "Read", active: []},
				share,
				onCall: NOT_ASKED,
			});
		const updateOf = (share: ShareWeek) =>
			renderHealth({...quiet, unread: report(share).unread}, TABLE, false);

		const off = updateOf(NOT_ASKED);
		expect(off.status).toBe("ON_TRACK");
		expect(off.body).not.toContain("fabrika-share");

		const unread = updateOf({_tag: "Unread", reason: "cannot read #10's labels: HTTP 502"});
		expect(unread.status).toBe("AT_RISK");
		expect(unread.body).toContain("- Could not check: fabrika-share");
	});

	it("says a past-target count it could not read in words, never as a number", () => {
		const report = {
			flags: [],
			unread: [{check: "past-target" as const, issue: 40, reason: "no Response target yet"}],
		};
		const update = renderHealth({...quiet, unread: report.unread}, TABLE, false, {
			open: 2,
			pastTarget: flagCount(report, "PastTarget", "past-target"),
			spend: {_tag: "Nothing"},
			share: 20,
		});

		expect(update.body).toContain(
			"- Open items: 2 (past their response target: not known, 1 item could not be checked)",
		);
		expect(update.status).toBe("AT_RISK");
	});
});
