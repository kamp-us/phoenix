/**
 * Unit-tier per ADR 0082: row-level filtering is the integration tier's job; what
 * THIS test proves is that the author UNION WIRES the public-live seam predicate
 * into every arm. The counter reads resolve through `db.run(sql).then()` (a Promise,
 * no `.toSQL()`), so the compiled SQL is captured off a RECORDING D1 binding.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {createDrizzle, Drizzle, makeDrizzleAccess} from "../../db/Drizzle.ts";
import {Stats, StatsLive} from "./Stats.ts";

interface RecordedQuery {
	sql: string;
}

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

// The distinct-author UNION is the only recorded read that references `author_id`.
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
			assert.include(sql, `"post_record"."is_draft" is not 1`);
		}),
	);

	it.effect("a live author still counts — no arm inverts the sandbox mask", () =>
		Effect.gen(function* () {
			const sql = (yield* recordAuthorUnion).toLowerCase();
			// `IS NOT NULL` would invert the mask and drop the live authors this counter
			// exists to count.
			assert.notInclude(sql, "sandboxed_at is not null");
			assert.match(sql, /count\(distinct author_id\)/, "still a distinct-author count");
		}),
	);
});

describe("Stats.getLandingStats — the author counter's UNION structure (#2031, AC4)", () => {
	// The suite above asserts the per-arm filters are wired; this one asserts the arms
	// compose into the intended set operation, so a dropped arm, a count split across
	// separate reads, or a `UNION`→`UNION ALL` swap fails here.
	const flatten = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

	it.effect("three arms are joined by two deduplicating UNION operators (not UNION ALL)", () =>
		Effect.gen(function* () {
			const flat = flatten(yield* recordAuthorUnion);
			const unions = flat.match(/\bunion\b(?!\s+all)/g) ?? [];
			assert.strictEqual(unions.length, 2, "exactly two UNION operators join three arms");
			assert.notMatch(flat, /\bunion\s+all\b/, "arms deduplicate with UNION, never UNION ALL");
		}),
	);

	it.effect("the three record-table arms appear in order inside a COUNT(DISTINCT) subquery", () =>
		Effect.gen(function* () {
			const flat = flatten(yield* recordAuthorUnion);
			assert.match(
				flat,
				/count\(distinct author_id\)[^(]*\(\s*select author_id from definition_record where .+ union select author_id from post_record where .+ union select author_id from comment_record where .+\)/,
				"COUNT(DISTINCT author_id) over (definition_record UNION post_record UNION comment_record)",
			);
		}),
	);
});
