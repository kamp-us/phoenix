/**
 * The letter index's half of `Sozluk.listTermSummariesConnection` (#9267): a `letter` narrows
 * the page to one Turkish alphabet letter, and `sort: "alphabetical"` orders what is left by
 * the collation key rather than by SQLite's ASCII byte order.
 *
 * Unit-tier per ADR 0082: the collation rules themselves are pinned in
 * `turkish-collation.unit.test.ts`; what this proves is that the query wires them in — on the
 * page read, on the masked count, and on a cursor page.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {anonymousViewer} from "../lifecycle/EntityLifecycle.ts";
import {Sozluk} from "./Sozluk.ts";
import {D1_MAX_BOUND_PARAMS, runList, scriptedAccess, sozlukLayer} from "./term-list.testing.ts";
import {turkishCollationKey, turkishLetterKeyRange} from "./turkish-collation.ts";

const C_RANGE = turkishLetterKeyRange("c");

describe("Sozluk.listTermSummariesConnection — the letter index (#9267)", () => {
	it.effect("bounds the page by the letter's half-open collation range, never a LIKE prefix", () =>
		Effect.gen(function* () {
			const {page, pageParams} = yield* runList({sort: "alphabetical", letter: "c"});
			assert.isDefined(C_RANGE);
			assert.notMatch(page, /like/, "no naive LIKE 'c%' — it would swallow ç");
			assert.include(pageParams, C_RANGE?.start, "the range's lower bound is bound in");
			assert.include(pageParams, C_RANGE?.end, "the range's exclusive upper bound is bound in");
			assert.include(page, "replace(", "the bound is compared against the collation key");
		}),
	);

	it.effect("carries the letter bound into the masked count, so hasNext cannot overstate", () =>
		Effect.gen(function* () {
			const {count} = yield* runList({sort: "alphabetical", letter: "c"});
			assert.include(count, "replace(", "the count is bounded by the same key expression");
			assert.include(count, "lower(", "and by the same fold");
		}),
	);

	it.effect("orders by the collation key, never by the raw title column", () =>
		Effect.gen(function* () {
			const {page} = yield* runList({sort: "alphabetical", letter: "c"});
			assert.notMatch(
				page,
				/order by "term_record"\."title"/,
				"a raw title ORDER BY is the ASCII order this sort exists to refuse",
			);
			assert.match(page, /order by replace\(/, "the ORDER BY leads with the key expression");
		}),
	);

	it.effect("resumes a letter page from the cursor row's own collation key", () =>
		Effect.gen(function* () {
			const {page, pageParams} = yield* runList({
				sort: "alphabetical",
				letter: "c",
				after: "onceki-terim",
			});
			// `runList`'s cursor row is titled `önceki terim`; its key is computed from that
			// title, because nothing stores it.
			assert.include(
				pageParams,
				turkishCollationKey("önceki terim"),
				"the keyset's lead value is the cursor title's key",
			);
			assert.include(page, "replace(", "the keyset compares keys, not raw titles");
		}),
	);

	it.effect("answers a letter outside the alphabet with nothing — never the whole corpus", () =>
		Effect.gen(function* () {
			const {access, builders, prepared} = scriptedAccess([]);
			const page = yield* Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.listTermSummariesConnection({
					sort: "alphabetical",
					letter: "q",
					sandboxViewer: anonymousViewer,
				});
			}).pipe(Effect.provide(sozlukLayer(access)));

			assert.deepStrictEqual(page.rows, []);
			assert.strictEqual(page.totalCount, 0);
			assert.strictEqual(page.hasNextPage, false);
			// The refusal short-circuits ABOVE the query — an unmatched letter that fell through
			// to an unfiltered `WHERE` would render `/sozluk/harf/q` as the whole index.
			assert.strictEqual(builders.length + prepared.length, 0, "no read reached the database");
		}),
	);

	it.effect(
		"keeps both letter reads under D1's bound-parameter ceiling, first page and cursor",
		() =>
			Effect.gen(function* () {
				// The failure this pins is not a slow query but a rejected one: D1 refuses a statement
				// carrying more than 100 bound parameters, so the page served neither rows nor an empty
				// state until the fold table was inlined. A cursor page is the worst case — it carries
				// the keyset predicate's copy of the key expression on top of the range and the order.
				const first = yield* runList({sort: "alphabetical", letter: "c"});
				const resumed = yield* runList({sort: "alphabetical", letter: "c", after: "onceki-terim"});
				for (const [name, params] of [
					["masked count", first.countParams],
					["first page", first.pageParams],
					["cursor page", resumed.pageParams],
					["cursor page count", resumed.countParams],
				] as const) {
					assert.isAtMost(
						params.length,
						D1_MAX_BOUND_PARAMS,
						`the ${name} read binds ${params.length} parameters; D1 rejects past ${D1_MAX_BOUND_PARAMS}`,
					);
				}
			}),
	);

	it.effect("leaves an unfiltered sort alone — no letter, no key expression", () =>
		Effect.gen(function* () {
			const {page} = yield* runList({sort: "recent"});
			assert.notInclude(page, "replace(", "the home lists pay nothing for the letter index");
		}),
	);
});
