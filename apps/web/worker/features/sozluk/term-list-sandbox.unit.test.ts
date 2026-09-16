/**
 * `Sozluk.listTermSummariesConnection` sandbox-visibility wiring. `term_record` is a
 * summary cache with no lifecycle columns, so visibility has to be derived from the
 * definitions it summarizes — without that, a çaylak's sandbox-only term lands at the top
 * of the anonymous /sozluk front door.
 *
 * Unit-tier per ADR 0082: row-level filtering is integration's job, so what this proves
 * is only that both reads wire the mask in and that it is viewer-aware.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {runList} from "./term-list.testing.ts";

const EXISTS_OVER_DEFINITIONS =
	/exists \(select 1 from "definition_record" where .*"definition_record"\."term_slug" = "term_record"\."slug"/;

describe("Sozluk.listTermSummariesConnection — the /sozluk lists exclude sandbox-only terms (#3724)", () => {
	it.effect("the page query gates term_record on an EXISTS over live definitions", () =>
		Effect.gen(function* () {
			const {page} = yield* runList({sort: "recent"});
			assert.match(page, EXISTS_OVER_DEFINITIONS, "correlated EXISTS over definition_record");
			assert.match(page, /"definition_record"\."removed_at" is null/, "removal guard present");
			assert.match(page, /"definition_record"\."sandboxed_at" is null/, "sandbox mask present");
			assert.notMatch(page, /sandboxed_at" is not null/, "mask is IS NULL, never IS NOT NULL");
		}),
	);

	it.effect("totalCount carries the identical mask — never an unfiltered count(*)", () =>
		Effect.gen(function* () {
			const {count} = yield* runList({sort: "recent"});
			assert.match(count, EXISTS_OVER_DEFINITIONS, "the count is masked, not a bare count(*)");
			assert.match(count, /"definition_record"\."removed_at" is null/, "removal guard present");
			assert.match(count, /"definition_record"\."sandboxed_at" is null/, "sandbox mask present");
		}),
	);

	it.effect("an anonymous viewer gets the public mask only — no author arm", () =>
		Effect.gen(function* () {
			const {page, count} = yield* runList({sort: "recent"});
			for (const sql of [page, count]) {
				assert.notMatch(sql, /"definition_record"\."author_id" =/, "no author arm when anonymous");
			}
		}),
	);

	it.effect("a signed-in viewer additionally sees their OWN not-yet-public term", () =>
		Effect.gen(function* () {
			const {page, count, pageParams} = yield* runList({sort: "recent", viewerId: "u-caylak"});
			for (const rendered of [page, count]) {
				assert.include(
					rendered,
					'"definition_record"."sandboxed_at" is null)) or ("definition_record"."author_id" = ?)',
					"the sandbox arm widens to the viewer's own definitions",
				);
			}
			assert.include(pageParams, "u-caylak", "the viewer id is bound into the mask");
		}),
	);

	it.effect("a cursor page keeps BOTH the keyset predicate and the mask", () =>
		Effect.gen(function* () {
			const {page} = yield* runList({sort: "recent", after: "onceki-terim"});
			assert.match(page, EXISTS_OVER_DEFINITIONS, "the mask survives pagination");
			assert.match(page, /"term_record"\."last_activity_at" </, "the keyset predicate survives");
		}),
	);

	it.effect("a moderator sees every not-removed term — the sandbox arm drops", () =>
		Effect.gen(function* () {
			const {page} = yield* runList({
				sort: "recent",
				sandboxViewer: {viewerId: "u-mod", canSeeSandboxed: true, seesSandboxedInPlace: false},
			});
			assert.match(page, EXISTS_OVER_DEFINITIONS, "still gated on having a readable definition");
			assert.match(page, /"definition_record"\."removed_at" is null/, "removal guard stays");
			assert.notMatch(page, /sandboxed_at/, "no sandbox restriction for a moderator");
		}),
	);
});
