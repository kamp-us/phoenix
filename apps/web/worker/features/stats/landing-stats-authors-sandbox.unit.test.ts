/**
 * `Stats.getLandingStats` author-UNION sandbox-visibility wiring (#1391) — the
 * security fix: the public landing `totalAuthors` counter must NOT count a çaylak
 * who only has sandboxed (un-promoted) content. The counter is a distinct-author
 * UNION across the three view tables; every arm must carry the #1205
 * `sandboxed_at IS NULL` clause beside its existing `removed_at IS NULL` guard,
 * agreeing with the per-product `total_authors` columns (`makePersistPanoStats`,
 * `recomputeSozlukStats`) that already exclude sandboxed rows.
 *
 * Unit-tier per ADR 0082: row-level filtering is the integration tier's job; what
 * THIS test proves is that the author UNION WIRES the sandbox clause into every arm.
 * The counter reads resolve through `db.run(sql).then()` (a Promise, no `.toSQL()`),
 * so — like `profile-counts-sandbox.unit.test.ts` — the compiled SQL is captured off
 * a RECORDING D1 binding whose `prepare(sql)` records every executed statement.
 *
 * The negative the fix closes: each arm filters `sandboxed_at IS NULL`, so an author
 * whose ONLY rows are sandboxed contributes zero `author_id` to every arm ⇒ excluded
 * from the distinct count; a live author's rows survive every guard ⇒ still counted.
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

describe("Stats.getLandingStats — public totalAuthors excludes sandbox-only authors (#1391)", () => {
	it.effect(
		"every UNION arm filters removed_at AND sandboxed_at (sandbox-only author not counted)",
		() =>
			Effect.gen(function* () {
				const sql = (yield* recordAuthorUnion).toLowerCase();
				// One arm per content table; each must carry BOTH guards so a sandbox-only
				// author drops out of every arm ⇒ out of the distinct-author count.
				const guards = sql.match(/removed_at is null and sandboxed_at is null/g) ?? [];
				assert.strictEqual(
					guards.length,
					3,
					"all three UNION arms carry the removed+sandboxed guard",
				);
				assert.include(sql, "definition_record where removed_at is null and sandboxed_at is null");
				assert.include(sql, "post_record where removed_at is null and sandboxed_at is null");
				assert.include(sql, "comment_record where removed_at is null and sandboxed_at is null");
			}),
	);

	it.effect("a live author still counts — no arm gates sandboxed_at IS NOT NULL", () =>
		Effect.gen(function* () {
			const sql = (yield* recordAuthorUnion).toLowerCase();
			// The mask is `sandboxed_at IS NULL` (keep live), never `IS NOT NULL` (which
			// would invert it and drop the live authors the counter is meant to count).
			assert.notInclude(sql, "sandboxed_at is not null");
			assert.match(sql, /count\(distinct author_id\)/, "still a distinct-author count");
		}),
	);
});
