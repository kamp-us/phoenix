/**
 * `Sozluk.listTermSummariesConnection` sandbox-visibility wiring (#3724) — the security
 * fix for the /sozluk root lists (`terms` / `recentTerms` / `popularTerms`). The list
 * selects from `term_record`, a summary cache with no lifecycle columns of its own, so
 * visibility must be derived from the definitions it summarizes: BOTH the page query and
 * `totalCount` carry an `EXISTS` over `definition_record` masked by `publicLiveWhere`.
 * Without it a çaylak's sandbox-only term lands at the top of the anonymous /sozluk front
 * door and its term page renders zero definition cards (#1205/#1424).
 *
 * Unit-tier per ADR 0082: row-level filtering is integration's job; what THIS proves is
 * that both reads WIRE the mask in, and that it is viewer-aware (the author's own arm
 * appears only for a signed-in viewer, and a moderator drops the sandbox arm entirely).
 * The compiled SQL is captured off a substituted `Drizzle` seam that renders each
 * builder's `.toSQL()` (the `Sozluk.connection.unit.test.ts` scripted-access idiom).
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {type ListSort, Sozluk, SozlukLive} from "./Sozluk.ts";

const hasToSQL = (v: unknown): v is {toSQL: () => {sql: string; params: unknown[]}} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

/**
 * The two reads land on DIFFERENT capture surfaces, which is why this harness has two.
 * The page read hands `run` the un-awaited builder, so it renders via `.toSQL()`. The
 * `totalCount` read finalizes inside the callback (`.get().then(…)`), so `run` only ever
 * sees a promise — its SQL is recoverable solely at the D1 binding, off `prepare`/`bind`.
 */
function scriptedAccess(results: ReadonlyArray<unknown>): {
	access: DrizzleAccess;
	builders: {sql: string; params: unknown[]}[];
	prepared: {sql: string; params: unknown[]}[];
} {
	const state = {i: 0};
	const builders: {sql: string; params: unknown[]}[] = [];
	const prepared: {sql: string; params: unknown[]}[] = [];
	// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed; only `prepare`/`batch` are exercised and every result is scripted.
	const capturingD1 = {
		prepare: (sql: string) => {
			const entry = {sql, params: [] as unknown[]};
			prepared.push(entry);
			return {
				bind(...params: unknown[]) {
					entry.params = params;
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
			};
		},
		async batch() {
			return [];
		},
	} as unknown as D1Database;
	const renderDb = drizzle(capturingD1, {relations});

	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			const built = fn(renderDb) as unknown;
			if (hasToSQL(built)) builders.push(built.toSQL());
			const value = results[state.i++] as A;
			return Effect.succeed(value);
		},
		batch: () => Effect.die(new Error("the term list must not batch")),
	};
	return {access, builders, prepared};
}

// biome-ignore lint/plugin: a service double — the term list never reaches the Vote service.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("the term list must not cast a vote")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

const sozlukLayer = (access: DrizzleAccess) =>
	SozlukLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

/** The connection's two rendered reads: the masked `totalCount` and the masked page. */
const runList = (opts: {
	sort?: ListSort;
	after?: string;
	viewerId?: string | null;
	sandboxViewer?: SandboxViewer;
}): Effect.Effect<{count: string; page: string; pageParams: unknown[]}> =>
	Effect.gen(function* () {
		const cursorRow = {slug: "onceki-terim", totalScore: 3, lastActivityAt: new Date(0)};
		const {access, builders, prepared} = scriptedAccess(
			opts.after === undefined
				? [0 /* count */, [] /* page */]
				: [0 /* count */, cursorRow, [] /* page */],
		);
		yield* Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.listTermSummariesConnection(opts);
		}).pipe(Effect.provide(sozlukLayer(access)));

		const count = prepared[0];
		const page = builders[0];
		assert.isDefined(count, "the totalCount read reached the D1 binding");
		assert.isDefined(page, "the page read rendered off the seam");
		return {
			count: count.sql.toLowerCase(),
			page: page.sql.toLowerCase(),
			pageParams: page.params,
		};
	});

const EXISTS_OVER_DEFINITIONS =
	/exists \(select 1 from "definition_record" where .*"definition_record"\."term_slug" = "term_record"\."slug"/;

describe("Sozluk.listTermSummariesConnection — the /sozluk lists exclude sandbox-only terms (#3724)", () => {
	it.effect("the page query gates term_record on an EXISTS over live definitions", () =>
		Effect.gen(function* () {
			const {page} = yield* runList({sort: "recent"});
			assert.match(page, EXISTS_OVER_DEFINITIONS, "correlated EXISTS over definition_record");
			assert.match(page, /"definition_record"\."removed_at" is null/, "removal guard present");
			assert.match(page, /"definition_record"\."sandboxed_at" is null/, "sandbox mask present");
			// Never the inverted mask — that would show ONLY the sandboxed terms.
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
				sandboxViewer: {viewerId: "u-mod", canSeeSandboxed: true},
			});
			assert.match(page, EXISTS_OVER_DEFINITIONS, "still gated on having a readable definition");
			assert.match(page, /"definition_record"\."removed_at" is null/, "removal guard stays");
			assert.notMatch(page, /sandboxed_at/, "no sandbox restriction for a moderator");
		}),
	);
});
