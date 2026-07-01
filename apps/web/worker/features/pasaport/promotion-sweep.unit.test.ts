/**
 * `Pasaport.promoteToYazar` backlog-sweep coverage (#1206) — the load-bearing
 * correctness concern: the tier flip and the sandbox sweep are ONE atomic D1 batch
 * (ADR 0014), and every statement is *conditional*, which is what makes the
 * promotion idempotent and a mixed backlog land consistent. Proven by rendering the
 * batch's `.toSQL()` over a no-op D1 (the `Pano.connection.unit.test.ts` idiom) —
 * no engine, so this is a unit test; a real-D1 promote-twice / mixed-content
 * fidelity test (the `account-deletion.test.ts` precedent) is a follow-up in the
 * integration tier.
 *
 * The three structural guarantees asserted here:
 *   - **Atomic.** All four writes go through a single `batch`, so the world never
 *     sees a tier flipped with the backlog half-swept (or the reverse).
 *   - **Idempotent.** The tier UPDATE is guarded `tier = 'çaylak'` and the sweep
 *     `sandboxed_at IS NOT NULL` — so a re-run (promote twice) matches zero rows and
 *     `promoted` reads false the second time.
 *   - **Mixed-content-safe.** The sweep WHERE is exactly the #1205 backlog predicate
 *     (`sandboxed_at IS NOT NULL AND removed_at IS NULL AND author_id = ?`), so it
 *     flips only this author's still-sandboxed, not-removed rows — live rows
 *     (`sandboxed_at` already null) and removed rows (`removed_at` set) are untouched.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	relations,
	type Stmt,
} from "../../db/Drizzle.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

// A real drizzle client over a no-op D1 — used ONLY to render the batch statements'
// `.toSQL()`; it never executes (the scripted `batch` renders, then returns a fake
// per-statement result).
// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; nothing here executes against it.
const noopD1 = {
	prepare: () => ({
		bind() {
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
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {relations});

const inertAuth = {} as BetterAuthInstance;

// Captures the batch's rendered statements and answers with a scripted per-statement
// result whose first element's `meta.changes` drives `promoted`.
function capturingBatch(tierChanges: number): {
	access: DrizzleAccess;
	statements: () => {sql: string; params: unknown[]}[];
} {
	const captured: {sql: string; params: unknown[]}[] = [];
	const access: DrizzleAccess = {
		run: () => Effect.die(new Error("promoteToYazar must not run a single statement — it batches")),
		batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(fn: (db: DrizzleDb) => T) => {
			const stmts = fn(renderDb);
			for (const s of stmts) {
				// biome-ignore lint/plugin: drizzle's `BatchItem`/`Stmt` carries `.toSQL()` at runtime but doesn't expose it on the type; render it to assert the built SQL.
				const renderable = s as unknown as {toSQL: () => {sql: string; params: unknown[]}};
				captured.push(renderable.toSQL());
			}
			// A fake per-statement batch result — the method reads only `.meta.changes`;
			// the real generic `BatchResult` shape isn't reconstructable in a no-engine double.
			const result = stmts.map((_, i) => ({meta: {changes: i === 0 ? tierChanges : 0}}));
			return Effect.succeed(result as never);
		},
	};
	return {access, statements: () => captured};
}

const pasaportOver = (access: DrizzleAccess) =>
	makePasaportLive(inertAuth).pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("Pasaport.promoteToYazar — atomic, idempotent backlog sweep", () => {
	it.effect("emits ONE batch of four statements: the tier flip + the three content sweeps", () => {
		const cap = capturingBatch(1);
		return Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.promoteToYazar({userId: "u-caylak"});
			assert.strictEqual(cap.statements().length, 4, "tier UPDATE + def/post/comment sweeps");
		}).pipe(Effect.provide(pasaportOver(cap.access)));
	});

	it.effect(
		"the tier UPDATE is guarded `tier = çaylak` (idempotent — promote-twice no-ops)",
		() => {
			const cap = capturingBatch(1);
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				yield* pasaport.promoteToYazar({userId: "u-caylak"});

				const tier = cap.statements()[0];
				assert.isTrue(tier !== undefined);
				if (tier === undefined) return;
				const sql = tier.sql.toLowerCase();
				assert.match(sql, /update\s+"user"/);
				assert.match(sql, /"tier"\s*=/); // sets tier
				assert.match(sql, /where[\s\S]*"id"[\s\S]*"tier"/); // guarded on BOTH id and current tier
				assert.includeMembers(tier.params as unknown[], ["yazar", "u-caylak", "çaylak"]);
			}).pipe(Effect.provide(pasaportOver(cap.access)));
		},
	);

	it.effect(
		"each content sweep clears sandboxed_at only for sandboxed, not-removed, owned rows",
		() => {
			const cap = capturingBatch(1);
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				yield* pasaport.promoteToYazar({userId: "u-caylak"});

				// Statements 1..3 are the definition/post/comment sweeps.
				const sweeps = cap.statements().slice(1);
				assert.strictEqual(sweeps.length, 3);
				for (const sweep of sweeps) {
					const sql = sweep.sql.toLowerCase();
					assert.match(sql, /set[\s\S]*"sandboxed_at"\s*=\s*\?/); // assigns sandboxed_at…
					assert.include(sweep.params as unknown[], null); // …to null (flips to live)
					assert.match(sql, /"sandboxed_at"\s+is not null/); // only currently-sandboxed
					assert.match(sql, /"removed_at"\s+is null/); // never resurrect removed content
					assert.match(sql, /"author_id"\s*=/); // scoped to this author's backlog
					assert.include(sweep.params as unknown[], "u-caylak");
				}
			}).pipe(Effect.provide(pasaportOver(cap.access)));
		},
	);

	it.effect("promoted reflects the tier-flip changes count — true when a çaylak flips", () =>
		Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			const {promoted} = yield* pasaport.promoteToYazar({userId: "u-caylak"});
			assert.isTrue(promoted);
		}).pipe(Effect.provide(pasaportOver(capturingBatch(1).access))),
	);

	it.effect(
		"promoted is false on a re-run / already-yazar (the guarded UPDATE matches 0 rows)",
		() =>
			Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				const {promoted} = yield* pasaport.promoteToYazar({userId: "u-yazar-already"});
				assert.isFalse(promoted);
			}).pipe(Effect.provide(pasaportOver(capturingBatch(0).access))),
	);
});
