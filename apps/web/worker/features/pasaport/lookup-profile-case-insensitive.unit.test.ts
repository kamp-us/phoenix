/**
 * `Pasaport.lookupProfile` normalizes the incoming username the same way the write
 * path does, so a mixed-case `/u/Rasit` resolves the lowercased stored `rasit` row
 * instead of 404ing (#2445). Usernames are written lowercased (`setUsername` →
 * `normalizeUsername`); the read must match that canonical form or the exact `eq`
 * misses. This pins the profile-row SELECT to bind the lowercased handle regardless
 * of the URL casing, and that a genuinely-absent handle still resolves to `null`.
 *
 * Unit-tier per ADR 0082: the query BUILDER is captured off `.toSQL()` (never
 * executed), so `params` exposes the bound `where "username" = ?` value directly —
 * that bound value IS the normalized lookup key, which is exactly what this asserts.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	DrizzleError,
	relations,
} from "../../db/Drizzle.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

const inertAuth = {} as BetterAuthInstance;

const hasToSQL = (v: unknown): v is {toSQL: () => {sql: string; params: unknown[]}} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
	typeof v === "object" && v !== null && typeof (v as {then?: unknown}).then === "function";

// An inert D1 binding: the count reads (`countByAuthor`, a `.then()`) execute here and
// resolve to empty; only SQL compilation is exercised, results are inert.
function inertD1(): D1Database {
	// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed; only SQL compilation is exercised, results are inert.
	return {
		prepare() {
			const stmt = {
				bind: () => stmt,
				all: async () => ({results: []}),
				first: async () => null,
				run: async () => ({}),
				raw: async () => [],
			};
			return stmt;
		},
		batch: async () => [],
	} as unknown as D1Database;
}

interface CapturedBuilder {
	sql: string;
	params: unknown[];
}

// Drives `lookupProfile` over scripted `run` results while CAPTURING each query
// BUILDER's compiled SQL + bound params off `.toSQL()` (without executing it); a count
// PROMISE is awaited so it resolves inertly. The first captured builder is the
// profile-row SELECT — its bound param is the normalized lookup key under test.
function capturingAccess(
	binding: D1Database,
	results: ReadonlyArray<unknown>,
): {access: DrizzleAccess; builders: CapturedBuilder[]} {
	const renderDb = drizzle(binding, {relations});
	const builders: CapturedBuilder[] = [];
	const state = {i: 0};
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) =>
			Effect.tryPromise({
				try: async () => {
					const built = fn(renderDb) as unknown;
					if (hasToSQL(built)) {
						const compiled = built.toSQL();
						builders.push({sql: compiled.sql, params: compiled.params});
					} else if (isThenable(built)) {
						await built;
					}
					return results[state.i++] as A;
				},
				catch: (cause) => new DrizzleError({cause}),
			}),
		batch: () => Effect.die(new Error("lookupProfile must not batch")),
	};
	return {access, builders};
}

const pasaportOver = (access: DrizzleAccess) =>
	makePasaportLive(inertAuth).pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const STORED_ROW = {
	userId: "user-rasit",
	username: "rasit",
	displayName: "Rasit",
	image: null,
	totalKarma: 0,
};

// A found profile: 1 profile-row SELECT (builder) then 3 `countByAuthor` reads.
const foundResults = [[STORED_ROW], 0, 0, 0] as const;

// Run `lookupProfile(arg)` over the found script; return the captured profile-row
// SELECT builder (the first `run`) so its bound `where username = ?` param can be read.
const runLookup = (arg: string) =>
	Effect.gen(function* () {
		const {access, builders} = capturingAccess(inertD1(), [...foundResults]);
		yield* Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.lookupProfile(arg);
		}).pipe(Effect.provide(pasaportOver(access)));
		const profileRow = builders[0];
		if (!profileRow)
			return yield* Effect.die(new Error("expected the profile-row SELECT builder to be captured"));
		return profileRow;
	});

describe("Pasaport.lookupProfile — case-insensitive lookup (#2445)", () => {
	for (const arg of ["Rasit", "RASIT", "rasit", "  Rasit  "]) {
		it.effect(`\`${arg}\` binds the lowercased canonical handle \`rasit\``, () =>
			Effect.gen(function* () {
				const profileRow = yield* runLookup(arg);
				assert.match(profileRow.sql.toLowerCase(), /"username" = \?/, "exact eq on username");
				assert.include(
					profileRow.params as unknown[],
					"rasit",
					"the lookup normalizes to the stored-lowercased handle before the eq",
				);
				// A non-canonical raw arg must never survive to the bound key; skip when the
				// arg already IS the canonical form (nothing distinct to exclude).
				if (arg.trim() !== "rasit") {
					assert.notInclude(
						profileRow.params as unknown[],
						arg.trim(),
						"the raw mixed-case arg is never the bound key",
					);
				}
			}),
		);
	}

	it.effect("a genuinely-absent handle still resolves to null (normalize ≠ match-any)", () =>
		Effect.gen(function* () {
			// Empty profile-row result ⇒ no row ⇒ null, and the counts never fire.
			const {access} = capturingAccess(inertD1(), [[]]);
			const row = yield* Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.lookupProfile("Nobody");
			}).pipe(Effect.provide(pasaportOver(access)));
			assert.strictEqual(
				row,
				null,
				"an absent username 404s — casing normalization is not match-any",
			);
		}),
	);
});
