/**
 * The rendering seam `Sozluk.listTermSummariesConnection`'s unit tests read the term-list SQL
 * through. Shared so the sandbox-mask suite and the letter-index suite render the ONE query
 * builder rather than each keeping a copy of the scaffolding that renders it.
 *
 * Unit-tier per ADR 0082: this proves what the query SAYS, never what a row-level filter
 * returns — execution stays integration's.
 */
import {assert} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {resolveSandboxViewer} from "../lifecycle/SandboxVisibility.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {type ListSort, Sozluk, SozlukLive} from "./Sozluk.ts";

const hasToSQL = (v: unknown): v is {toSQL: () => {sql: string; params: unknown[]}} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

/**
 * Two capture surfaces, because the two reads land differently: the page read hands `run`
 * an un-awaited builder that renders via `.toSQL()`, while `totalCount` finalizes inside
 * its callback, so `run` sees only a promise and its SQL is recoverable solely at the D1
 * binding.
 */
export function scriptedAccess(results: ReadonlyArray<unknown>): {
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

export const sozlukLayer = (access: DrizzleAccess) =>
	SozlukLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

export interface RenderedTermList {
	readonly count: string;
	readonly countParams: unknown[];
	readonly page: string;
	readonly pageParams: unknown[];
}

/**
 * D1's documented ceiling on bound parameters in one statement
 * (https://developers.cloudflare.com/d1/platform/limits/). A statement past it is rejected at
 * the binding, which is why this is a unit-tier assertion and not a style note: the letter
 * page's collation expression once bound 219 parameters and every letter read failed (#9267).
 */
export const D1_MAX_BOUND_PARAMS = 100;

/** Render one call's `totalCount` and page SQL, lower-cased for matching. */
export const runList = (opts: {
	sort?: ListSort;
	letter?: string;
	after?: string;
	viewerId?: string | null;
	sandboxViewer?: SandboxViewer;
}): Effect.Effect<RenderedTermList> =>
	Effect.gen(function* () {
		const cursorRow = {
			slug: "onceki-terim",
			title: "önceki terim",
			totalScore: 3,
			lastActivityAt: new Date(0),
		};
		const {access, builders, prepared} = scriptedAccess(
			opts.after === undefined
				? [0 /* count */, [] /* page */]
				: [0 /* count */, cursorRow, [] /* page */],
		);
		yield* Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.listTermSummariesConnection({
				...opts,
				sandboxViewer: resolveSandboxViewer(opts),
			});
		}).pipe(Effect.provide(sozlukLayer(access)));

		const count = prepared[0];
		const page = builders[0];
		assert.isDefined(count, "the totalCount read reached the D1 binding");
		assert.isDefined(page, "the page read rendered off the seam");
		return {
			count: count.sql.toLowerCase(),
			countParams: count.params,
			page: page.sql.toLowerCase(),
			pageParams: page.params,
		};
	});
