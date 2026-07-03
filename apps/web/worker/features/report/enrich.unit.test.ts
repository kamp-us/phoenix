/**
 * Moderation-queue enrichment merge — the T1 worker-seam unit (#1702), no engine.
 * The decisions asserted: each group is folded with its `<kind>:<id>`-keyed target
 * context onto the right `target*` fields; a group with no context keeps null
 * context (never dropped); and the excerpt clamp collapses whitespace + truncates.
 * The batched content READS (Pano/Sozluk SQL) are integration-tier, per the report
 * feature's stated split (`Report.unit.test.ts` docblock) — what's wrong-or-right
 * without D1 is this pure merge.
 */
import {assert, describe, it} from "@effect/vitest";
import {contextKeyOf, enrichOpenReports, type ReportTargetContext, toExcerpt} from "./enrich.ts";
import type {OpenReportGroup} from "./Report.ts";
import type {RowReputation} from "./reputation.ts";

// The reputation cluster is folded by a sibling merge (`reputation.unit.test.ts`); here
// the enrich merge only routes it by key, so an empty map exercises the fallback path.
const noReputations = new Map<string, RowReputation>();

const group = (
	targetKind: OpenReportGroup["targetKind"],
	targetId: string,
	over: Partial<OpenReportGroup> = {},
): OpenReportGroup => ({
	targetKind,
	targetId,
	reportCount: 1,
	reason: null,
	firstReportedAt: new Date("2026-07-02T10:00:00Z"),
	...over,
});

describe("contextKeyOf — the <kind>:<id> merge key", () => {
	it("matches the OpenReport view id spelling", () => {
		assert.strictEqual(contextKeyOf("post", "p-1"), "post:p-1");
		assert.strictEqual(contextKeyOf("definition", "d-9"), "definition:d-9");
	});
});

describe("toExcerpt — the single-line queue clamp", () => {
	it("collapses runs of whitespace to single spaces and trims", () => {
		assert.strictEqual(toExcerpt("  bir   iki\n\t üç  "), "bir iki üç");
	});

	it("passes a short body through untouched", () => {
		assert.strictEqual(toExcerpt("kısa gövde"), "kısa gövde");
	});

	it("truncates past the cap with an ellipsis", () => {
		const clamped = toExcerpt("x".repeat(200), 10);
		assert.strictEqual(clamped, `${"x".repeat(10)}…`);
	});
});

describe("enrichOpenReports — fold groups with their resolved target context", () => {
	it("lands each context on the matching group's target* fields", () => {
		const groups = [group("post", "p-1"), group("definition", "d-2")];
		const contexts = new Map<string, ReportTargetContext>([
			["post:p-1", {excerpt: "gönderi başlığı", author: "elif", ref: "p-1", authorId: "u-elif"}],
			[
				"definition:d-2",
				{excerpt: "tanım gövdesi", author: "deniz", ref: "istanbul", authorId: "u-deniz"},
			],
		]);

		const rows = enrichOpenReports(groups, contexts, noReputations);

		assert.deepStrictEqual(
			rows.map((r) => ({
				id: r.id,
				targetExcerpt: r.targetExcerpt,
				targetAuthor: r.targetAuthor,
				targetRef: r.targetRef,
			})),
			[
				{id: "post:p-1", targetExcerpt: "gönderi başlığı", targetAuthor: "elif", targetRef: "p-1"},
				{
					id: "definition:d-2",
					targetExcerpt: "tanım gövdesi",
					targetAuthor: "deniz",
					targetRef: "istanbul",
				},
			],
		);
	});

	it("keeps a group with no resolved context (null target*), never dropping the row", () => {
		const groups = [group("comment", "c-3", {reportCount: 4})];
		const rows = enrichOpenReports(groups, new Map(), noReputations);

		assert.strictEqual(rows.length, 1, "the row survives a missing context");
		const [row] = rows;
		assert.strictEqual(row?.id, "comment:c-3");
		assert.strictEqual(row?.reportCount, 4, "the report aggregation is untouched");
		assert.strictEqual(row?.targetExcerpt, null);
		assert.strictEqual(row?.targetAuthor, null);
		assert.strictEqual(row?.targetRef, null);
		assert.strictEqual(row?.authorTier, null, "no reputation ⇒ null author cluster");
		assert.strictEqual(
			row?.distinctReporters,
			4,
			"distinctReporters falls back to the report count",
		);
	});

	it("folds a reputation cluster onto the matching row by key", () => {
		const groups = [group("post", "p-1", {reportCount: 9})];
		const contexts = new Map<string, ReportTargetContext>([
			["post:p-1", {excerpt: "başlık", author: "kaan", ref: "p-1", authorId: "u-kaan"}],
		]);
		const reputations = new Map<string, RowReputation>([
			[
				"post:p-1",
				{authorTier: "çaylak", authorKarma: 2, authorPriorRemovals: 3, distinctReporters: 7},
			],
		]);

		const [row] = enrichOpenReports(groups, contexts, reputations);

		assert.strictEqual(row?.authorTier, "çaylak");
		assert.strictEqual(row?.authorKarma, 2);
		assert.strictEqual(row?.authorPriorRemovals, 3);
		assert.strictEqual(row?.distinctReporters, 7, "the explicit diversity count wins");
	});

	it("preserves group order and carries the report fields through the shaper", () => {
		const groups = [
			group("post", "p-1", {reportCount: 2, reason: "spam"}),
			group("comment", "c-2"),
		];
		const contexts = new Map<string, ReportTargetContext>([
			["comment:c-2", {excerpt: "yorum", author: "ada", ref: "p-parent", authorId: "u-ada"}],
		]);

		const rows = enrichOpenReports(groups, contexts, noReputations);

		assert.deepStrictEqual(
			rows.map((r) => r.id),
			["post:p-1", "comment:c-2"],
		);
		assert.strictEqual(rows[0]?.reason, "spam");
		assert.strictEqual(rows[0]?.targetExcerpt, null, "no context for p-1 → null");
		assert.strictEqual(rows[1]?.targetRef, "p-parent");
	});
});
