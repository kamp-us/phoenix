/**
 * Decision-feed enrichment merge — the T1 worker-seam unit (#1704), no engine. The
 * decisions asserted: each resolved group is folded with its `<kind>:<id>`-keyed target
 * context onto the right `target*` fields; the resolver id joins to its display handle
 * (the resolver is first-class); a group with no context keeps null context (never
 * dropped); and an unresolved resolver handle folds to null. The batched content /
 * identity READS live in the `Moderate`-gated `report.listResolved` resolver — what's
 * wrong-or-right without D1 is this pure fold.
 */
import {assert, describe, it} from "@effect/vitest";
import {enrichResolvedReports, type ReportTargetContext} from "./enrich.ts";
import type {ResolvedReportGroup} from "./Report.ts";

const group = (
	targetKind: ResolvedReportGroup["targetKind"],
	targetId: string,
	over: Partial<ResolvedReportGroup> = {},
): ResolvedReportGroup => ({
	targetKind,
	targetId,
	resolution: "removed",
	resolverId: "mod-1",
	resolvedAt: new Date("2026-07-03T10:00:00Z"),
	reportCount: 2,
	...over,
});

describe("enrichResolvedReports — fold decisions with target context + resolver handle", () => {
	it("lands each context on the matching group and joins the resolver handle", () => {
		const groups = [
			group("post", "p-1", {resolverId: "mod-a"}),
			group("definition", "d-2", {resolution: "dismissed", resolverId: "mod-b"}),
		];
		const contexts = new Map<string, ReportTargetContext>([
			["post:p-1", {excerpt: "gönderi başlığı", author: "elif", ref: "p-1", authorId: "u-elif"}],
			[
				"definition:d-2",
				{excerpt: "tanım gövdesi", author: "deniz", ref: "kelime", authorId: "u-deniz"},
			],
		]);
		const handles = new Map<string, string | null>([
			["mod-a", "founder"],
			["mod-b", "brother"],
		]);

		const rows = enrichResolvedReports(groups, contexts, handles);

		assert.strictEqual(rows.length, 2);
		assert.deepStrictEqual(
			{
				id: rows[0]?.id,
				resolution: rows[0]?.resolution,
				resolverHandle: rows[0]?.resolverHandle,
				targetExcerpt: rows[0]?.targetExcerpt,
				targetAuthor: rows[0]?.targetAuthor,
				targetRef: rows[0]?.targetRef,
			},
			{
				id: "post:p-1",
				resolution: "removed",
				resolverHandle: "founder",
				targetExcerpt: "gönderi başlığı",
				targetAuthor: "elif",
				targetRef: "p-1",
			},
		);
		assert.strictEqual(rows[1]?.resolution, "dismissed");
		assert.strictEqual(rows[1]?.resolverHandle, "brother");
		assert.strictEqual(rows[1]?.targetRef, "kelime");
	});

	it("keeps null context when the target is unresolved (never drops the decision)", () => {
		const rows = enrichResolvedReports(
			[group("comment", "c-9", {resolverId: "mod-a"})],
			new Map(),
			new Map([["mod-a", "founder"]]),
		);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]?.targetExcerpt, null);
		assert.strictEqual(rows[0]?.targetAuthor, null);
		assert.strictEqual(rows[0]?.targetRef, null);
		// The decision itself still resolves — the resolver stays first-class.
		assert.strictEqual(rows[0]?.resolverHandle, "founder");
	});

	it("folds an unresolved resolver handle to null (client falls back to the raw id)", () => {
		const rows = enrichResolvedReports(
			[group("post", "p-3", {resolverId: "mod-ghost"})],
			new Map<string, ReportTargetContext>([
				["post:p-3", {excerpt: "x", author: "y", ref: "p-3", authorId: "u-y"}],
			]),
			new Map(),
		);
		assert.strictEqual(rows[0]?.resolverHandle, null);
		assert.strictEqual(rows[0]?.resolverId, "mod-ghost");
	});
});
