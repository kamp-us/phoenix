/**
 * `Stats.getLandingStats` author-UNION public-live wiring (#1407, subsuming #1391).
 * The public landing `totalAuthors` counter is a distinct-author UNION across the
 * three record tables; every arm must reflect LIVE content only, so a çaylak with
 * only sandboxed rows — and a pano author with only draft posts — must NOT count.
 *
 * #1407 folds this onto the shared visibility seam: each arm now sources its filter
 * from `publicLiveWhere`/`publicLivePostWhere` for the anonymous viewer instead of a
 * hand-written `removed_at IS NULL AND sandboxed_at IS NULL` clause (#1391's point
 * fix, now replaced — not layered). For the anonymous viewer `publicLiveWhere`
 * reduces to removed+sandbox, and the post arm's `publicLivePostWhere` adds the
 * draft exclusion, so the post arm carries `is_draft IS NOT 1` on top.
 *
 * Unit-tier per ADR 0082: row-level filtering is the integration tier's job; what
 * THIS test proves is that the author UNION WIRES the seam predicate into every arm.
 * The counter reads resolve through `db.run(sql).then()` (a Promise, no `.toSQL()`),
 * so the compiled SQL is captured off a RECORDING D1 binding whose `prepare(sql)`
 * records every executed statement.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {createDrizzle, Drizzle, makeDrizzleAccess} from "../../db/Drizzle.ts";
import {Stats, StatsLive} from "./Stats.ts";

interface RecordedQuery {
	sql: string;
}

// A D1 binding that records the SQL of every statement it EXECUTES. `getLandingStats`
// issues three `db.run(sql).then()` reads (sozluk row, pano row, author UNION); each
// executes here, so its compiled SQL lands in `recorded`.
function recordingD1(): {binding: D1Database; recorded: RecordedQuery[]} {
	const recorded: RecordedQuery[] = [];
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

// Drive `getLandingStats` over a recording binding; return the one recorded statement
// that is the distinct-author UNION (the only read that references `author_id`).
const recordAuthorUnion = Effect.gen(function* () {
	const {binding, recorded} = recordingD1();
	const access = makeDrizzleAccess(createDrizzle(binding));
	yield* Effect.gen(function* () {
		const stats = yield* Stats;
		yield* stats.getLandingStats();
	}).pipe(Effect.provide(StatsLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)))));
	const union = recorded.find((q) => /author_id/i.test(q.sql));
	assert.isDefined(union, "the author UNION read executed against the binding");
	return (union as RecordedQuery).sql;
});

describe("Stats.getLandingStats — public totalAuthors excludes sandbox-only/draft-only authors (#1407)", () => {
	it.effect("every UNION arm sources the public-live filter from the shared seam", () =>
		Effect.gen(function* () {
			const sql = (yield* recordAuthorUnion).toLowerCase();
			// One arm per content table; each carries BOTH the removed and the sandbox
			// guard (the seam's anonymous-viewer reduction), so a sandbox-only author
			// drops out of every arm ⇒ out of the distinct-author count.
			const removed = sql.match(/"removed_at" is null/g) ?? [];
			const sandboxed = sql.match(/"sandboxed_at" is null/g) ?? [];
			assert.strictEqual(removed.length, 3, "all three arms carry the removed_at guard");
			assert.strictEqual(sandboxed.length, 3, "all three arms carry the sandboxed_at guard");
			assert.include(sql, `"definition_record"."sandboxed_at" is null`);
			assert.include(sql, `"post_record"."sandboxed_at" is null`);
			assert.include(sql, `"comment_record"."sandboxed_at" is null`);
		}),
	);

	it.effect("the post arm additionally excludes drafts (draft-only author not counted)", () =>
		Effect.gen(function* () {
			const sql = (yield* recordAuthorUnion).toLowerCase();
			// The post-aware seam (`publicLivePostWhere`) adds the draft gate, so a pano
			// author whose only post is an unpublished draft contributes no author_id.
			assert.include(sql, `"post_record"."is_draft" is not 1`);
		}),
	);

	it.effect("a live author still counts — no arm inverts the sandbox mask", () =>
		Effect.gen(function* () {
			const sql = (yield* recordAuthorUnion).toLowerCase();
			// The mask is `sandboxed_at IS NULL` (keep live), never `IS NOT NULL` (which
			// would invert it and drop the live authors the counter is meant to count).
			assert.notInclude(sql, "sandboxed_at is not null");
			assert.match(sql, /count\(distinct author_id\)/, "still a distinct-author count");
		}),
	);
});
