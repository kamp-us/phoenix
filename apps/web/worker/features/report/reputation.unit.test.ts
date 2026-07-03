/**
 * The triage-loop reputation-in-row merge — the T1 worker-seam unit (#1703, ADR
 * 0138), no engine. The decisions asserted: an author's tier/karma/prior-removals
 * fold onto the row's reputation cluster; an unresolved author leaves the WHOLE
 * cluster null (never a partial reputation); distinct-reporter count folds through,
 * falling back to the group's report count when the diversity read didn't separate
 * it (the PK-collapsed default). The batched künye / removal-count READS are
 * integration-tier; what's wrong-or-right without D1 is this pure merge.
 */
import {assert, describe, it} from "@effect/vitest";
import type {OpenReportGroup} from "./Report.ts";
import {
	type AuthorReputation,
	type ReporterDiversity,
	reputationKeyOf,
	rowReputationOf,
} from "./reputation.ts";

const group = (
	targetKind: OpenReportGroup["targetKind"],
	targetId: string,
	over: Partial<OpenReportGroup> = {},
): OpenReportGroup => ({
	targetKind,
	targetId,
	reportCount: 1,
	reason: null,
	firstReportedAt: new Date("2026-07-03T10:00:00Z"),
	...over,
});

describe("reputationKeyOf — the <kind>:<id> merge key", () => {
	it("matches the OpenReport view id spelling", () => {
		assert.strictEqual(reputationKeyOf("post", "p-1"), "post:p-1");
		assert.strictEqual(reputationKeyOf("comment", "c-9"), "comment:c-9");
	});
});

describe("rowReputationOf — fold author standing + reporter diversity onto the row", () => {
	it("lands a resolved author's tier, karma, and prior-removals", () => {
		const rep: AuthorReputation = {tier: "çaylak", karma: 3, priorRemovals: 2};
		const div: ReporterDiversity = {reportCount: 9, distinctReporters: 7};

		const row = rowReputationOf(group("post", "p-1", {reportCount: 9}), rep, div);

		assert.deepStrictEqual(row, {
			authorTier: "çaylak",
			authorKarma: 3,
			authorPriorRemovals: 2,
			distinctReporters: 7,
		});
	});

	it("carries a clean author (zero prior removals) faithfully — 0 is not absent", () => {
		const rep: AuthorReputation = {tier: "yazar", karma: 240, priorRemovals: 0};
		const row = rowReputationOf(group("definition", "d-1"), rep, {
			reportCount: 1,
			distinctReporters: 1,
		});

		assert.strictEqual(row.authorPriorRemovals, 0, "a clean author renders 0, never null");
		assert.strictEqual(row.authorTier, "yazar");
		assert.strictEqual(row.authorKarma, 240);
	});

	it("leaves the WHOLE author cluster null when the author is unresolved", () => {
		const row = rowReputationOf(group("comment", "c-3", {reportCount: 4}), undefined, undefined);

		assert.strictEqual(row.authorTier, null);
		assert.strictEqual(row.authorKarma, null);
		assert.strictEqual(row.authorPriorRemovals, null);
	});

	it("falls back distinctReporters to the group's reportCount when diversity is unresolved", () => {
		const rep: AuthorReputation = {tier: "çaylak", karma: 0, priorRemovals: 1};
		const row = rowReputationOf(group("post", "p-2", {reportCount: 5}), rep, undefined);

		assert.strictEqual(
			row.distinctReporters,
			5,
			"no separate diversity read ⇒ mirror the PK-collapsed report count",
		);
	});

	it("prefers the explicit distinct-reporter count over the report count when they differ", () => {
		const div: ReporterDiversity = {reportCount: 9, distinctReporters: 1};
		const row = rowReputationOf(group("post", "p-3", {reportCount: 9}), undefined, div);

		assert.strictEqual(row.distinctReporters, 1, "a grudge wave (9 rapor · 1 kişi) is surfaced");
	});
});
