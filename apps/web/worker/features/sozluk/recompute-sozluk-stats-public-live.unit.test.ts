/**
 * `recomputeSozlukStats` public-live count wiring. The `sozluk_stats` totals count LIVE
 * content only: a sandboxed çaylak definition is excluded like a removed one, so a
 * sandbox-only author never inflates `total_authors`.
 *
 * The counts execute through `.select(...).where(...).then(...)` (Promises, no `.toSQL()`),
 * so the compiled WHERE is captured by driving `SozlukLive.addDefinition` over a RECORDING
 * D1 binding whose `prepare(sql)` records every statement.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {createDrizzle, Drizzle, makeDrizzleAccess} from "../../db/Drizzle.ts";
import {TermSlug, UserId} from "../../lib/ids.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive} from "./Sozluk.ts";

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

// biome-ignore lint/plugin: a service double — `addDefinition` never reaches the Vote service.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.void,
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

const recordRecomputeCounts = Effect.gen(function* () {
	const {binding, recorded} = recordingD1();
	const access = makeDrizzleAccess(createDrizzle(binding));
	yield* Effect.gen(function* () {
		const sozluk = yield* Sozluk;
		yield* sozluk.addDefinition({
			termSlug: TermSlug.make("x"),
			termTitle: "X",
			authorId: UserId.make("a1"),
			authorName: "n",
			body: "a valid definition body",
		});
	}).pipe(
		Effect.provide(
			SozlukLive.pipe(
				Layer.provide(VoteStub),
				Layer.provide(ReactionStub),
				Layer.provide(PasaportIdentityStub),
				Layer.provide(Layer.succeed(Drizzle, access)),
			),
		),
	);
	return recorded.map((q) => q.sql.toLowerCase());
});

describe("recomputeSozlukStats — per-product totals exclude sandbox-only authors (#1407)", () => {
	it.effect("the distinct-author count excludes removed AND sandboxed definitions", () =>
		Effect.gen(function* () {
			const sqls = yield* recordRecomputeCounts;
			const authorCount = sqls.find((s) =>
				/count\(distinct "author_id"\)\s+from\s+"definition_record"/.test(s),
			);
			assert.isDefined(authorCount, "the distinct-author count executed");
			assert.include(authorCount as string, `"definition_record"."removed_at" is null`);
			assert.include(authorCount as string, `"definition_record"."sandboxed_at" is null`);
			assert.notInclude(authorCount as string, "sandboxed_at is not null");
		}),
	);

	it.effect("the definition count carries the same public-live guard", () =>
		Effect.gen(function* () {
			const sqls = yield* recordRecomputeCounts;
			const defCount = sqls.find((s) => /count\(\*\)\s+from\s+"definition_record"/.test(s));
			assert.isDefined(defCount, "the definition COUNT(*) executed");
			assert.include(defCount as string, `"definition_record"."removed_at" is null`);
			assert.include(defCount as string, `"definition_record"."sandboxed_at" is null`);
		}),
	);
});
