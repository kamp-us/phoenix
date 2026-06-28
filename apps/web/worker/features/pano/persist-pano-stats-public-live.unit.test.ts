/**
 * `makePersistPanoStats` public-live count wiring (#1407). The per-product
 * `pano_stats` totals (`total_posts`, `total_comments`, `total_authors`) count LIVE
 * content only: a sandboxed çaylak row is excluded like a removed one, and a draft
 * post is excluded too — a draft-only author must never inflate the totals.
 *
 * #1407 folds these counts onto the shared seam: posts route through the post-aware
 * `publicLivePostWhere` (removed + sandbox + draft) and comments through
 * `publicLiveWhere` (removed + sandbox), for the anonymous viewer — replacing the
 * hand-written `removed_at IS NULL AND sandboxed_at IS NULL` clauses.
 *
 * Unit-tier per ADR 0082: what THIS proves is that each count WIRES the seam
 * predicate. The counts execute against a RECORDING D1 binding whose `prepare(sql)`
 * records every statement, so their compiled WHERE clauses are inspectable.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {createDrizzle, makeDrizzleAccess} from "../../db/Drizzle.ts";
import {makePersistPanoStats} from "./pano-stats.ts";

function recordingD1(): {binding: D1Database; recorded: {sql: string}[]} {
	const recorded: {sql: string}[] = [];
	// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed; only SQL compilation is exercised, results are inert.
	const binding = {
		prepare(sql: string) {
			recorded.push({sql});
			const stmt = {
				bind() {
					return stmt;
				},
				async all() {
					return {results: []};
				},
				async first() {
					return null;
				},
				async run() {
					return {results: []};
				},
				async raw() {
					return [];
				},
			};
			return stmt;
		},
		async batch() {
			return [];
		},
	} as unknown as D1Database;
	return {binding, recorded};
}

const recordCounts = Effect.gen(function* () {
	const {binding, recorded} = recordingD1();
	const access = makeDrizzleAccess(createDrizzle(binding));
	yield* makePersistPanoStats(access.run)(new Date("2024-06-01T00:00:00.000Z"));
	return recorded.map((q) => q.sql.toLowerCase());
});

describe("makePersistPanoStats — per-product totals exclude sandbox-only/draft-only authors (#1407)", () => {
	it.effect("the post count excludes sandboxed AND draft posts", () =>
		Effect.gen(function* () {
			const sqls = yield* recordCounts;
			const postCount = sqls.find((s) => /count\(\*\)\s+from\s+"post_record"/.test(s));
			assert.isDefined(postCount, "the post COUNT(*) executed");
			assert.include(postCount as string, `"post_record"."removed_at" is null`);
			assert.include(postCount as string, `"post_record"."sandboxed_at" is null`);
			assert.include(postCount as string, `"post_record"."is_draft" is not 1`);
		}),
	);

	it.effect("the comment count excludes sandboxed comments (no draft dimension)", () =>
		Effect.gen(function* () {
			const sqls = yield* recordCounts;
			const commentCount = sqls.find((s) => /count\(\*\)\s+from\s+"comment_record"/.test(s));
			assert.isDefined(commentCount, "the comment COUNT(*) executed");
			assert.include(commentCount as string, `"comment_record"."removed_at" is null`);
			assert.include(commentCount as string, `"comment_record"."sandboxed_at" is null`);
			assert.notInclude(commentCount as string, "is_draft");
		}),
	);

	it.effect("the author UNION's post arm excludes drafts; both arms exclude sandboxed", () =>
		Effect.gen(function* () {
			const sqls = yield* recordCounts;
			const union = sqls.find((s) => /count\(distinct author_id\)/.test(s));
			assert.isDefined(union, "the author UNION executed");
			assert.include(union as string, `"post_record"."sandboxed_at" is null`);
			assert.include(union as string, `"post_record"."is_draft" is not 1`);
			assert.include(union as string, `"comment_record"."sandboxed_at" is null`);
			assert.notInclude(union as string, "sandboxed_at is not null");
		}),
	);
});
