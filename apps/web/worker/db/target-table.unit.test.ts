/**
 * The shared `scoreCache` seam must NOT touch `updated_at` (#1634).
 *
 * `updated_at` is the content-last-edited instant the "düzenlendi" badge reads
 * (`editedAfter`, `definition-fields.ts`). A vote's score refresh is a
 * derived-aggregate write, not a content edit — so bumping `updated_at` on a
 * vote made the badge lie and persistently corrupted the row's true last-edit
 * time. This guards all three target kinds at the one shared seam: the rendered
 * `scoreCache` UPDATE writes `score` (and, for posts, `hot_score` /
 * `last_activity_at`) but never `updated_at`.
 *
 * Rendered with `.toSQL()` against a no-op D1 (the `persist-term-summary` /
 * `VouchLedger` idiom — no engine, ADR 0082/0104/0105): the statement's column
 * SET is inspected, never executed. Row-level behavior on real D1 stays the
 * integration tier's job (`tests/integration/sozluk-mutations.test.ts`).
 */

import {drizzle} from "drizzle-orm/d1";
import {describe, expect, it} from "vitest";
import {relations} from "./Drizzle.ts";
import type {TargetKind} from "./target-kind.ts";
import {type TargetRecordMeta, targetTable} from "./target-table.ts";

// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed; only `.toSQL()` rendering is exercised — nothing is executed.
const noopD1 = {
	prepare: () => ({
		bind() {
			return this;
		},
		async all() {
			return {results: []};
		},
		async first() {
			return null;
		},
		async run() {
			return {};
		},
		async raw() {
			return [];
		},
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {relations});

const meta: TargetRecordMeta = {authorId: "u1", createdAtMs: 0, sandboxed: false};
const now = new Date("2026-07-02T00:00:00Z");

// drizzle's `BatchItem`/`Stmt` carries `.toSQL()` at runtime but doesn't expose it on the type.
const scoreCacheSql = (kind: TargetKind): string => {
	const stmt: unknown = targetTable[kind].scoreCache(renderDb, "t1", now, meta);
	return (stmt as {toSQL: () => {sql: string}}).toSQL().sql;
};

describe("scoreCache seam — a vote refreshes score, never updated_at (#1634)", () => {
	for (const kind of ["definition", "post", "comment"] as const) {
		it(`${kind}: sets score but not updated_at`, () => {
			const sql = scoreCacheSql(kind);
			expect(sql).toContain('"score"');
			expect(sql).not.toContain('"updated_at"');
		});
	}

	it("post: still refreshes hot_score and last_activity_at (activity ordering, distinct from the edit timestamp)", () => {
		const sql = scoreCacheSql("post");
		expect(sql).toContain('"hot_score"');
		expect(sql).toContain('"last_activity_at"');
		expect(sql).not.toContain('"updated_at"');
	});
});
