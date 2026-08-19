/**
 * The decision-feed enrichment fold (#1704). Load-bearing: a group whose context or
 * resolver handle won't resolve keeps nulls and is NEVER dropped — the decision itself
 * always survives. The batched reads it folds over live in the gated
 * `report.listResolved` resolver.
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
	waveId: null,
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
		assert.strictEqual(rows[0]?.resolverHandle, "founder");
	});

	it("carries the wave grouping id onto the row (null on a lone removal, #1855)", () => {
		const rows = enrichResolvedReports(
			[group("post", "p-1", {waveId: "wave-9"}), group("comment", "c-2", {waveId: null})],
			new Map(),
			new Map(),
		);
		assert.strictEqual(rows[0]?.waveId, "wave-9");
		assert.strictEqual(rows[1]?.waveId, null);
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
