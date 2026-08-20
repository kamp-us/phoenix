/**
 * `Pasaport.promoteToYazar` backlog-sweep coverage — the tier flip and the sandbox sweep
 * are ONE atomic D1 batch (ADR 0014) and every statement is conditional, which is what
 * makes a re-promote idempotent and a mixed backlog land consistent. Proven by rendering
 * the batch's `.toSQL()` over a no-op D1, so no engine runs and this stays unit tier.
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
	type Stmt,
} from "../../db/Drizzle.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

// A real drizzle client over a no-op D1, used ONLY to render `.toSQL()`; nothing executes.
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

// The first result's `meta.changes` is what drives `promoted`.
function capturingBatch(tierChanges: number): {
	access: DrizzleAccess;
	statements: () => {sql: string; params: unknown[]}[];
} {
	const captured: {sql: string; params: unknown[]}[] = [];
	const access: DrizzleAccess = {
		// The one permitted single statement is the pre-batch READ that captures which live
		// topics the sweep is about to un-hide content on (#6462) — it must precede the batch,
		// because afterwards `sandboxed_at` is null. The WRITES are still all-or-nothing, which
		// is what every case below asserts by counting `statements()`.
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) =>
			Effect.tryPromise({
				try: () => fn(renderDb),
				catch: (cause) => new DrizzleError({cause}),
			}),
		batch: <T extends Readonly<[Stmt, ...Stmt[]]>>(fn: (db: DrizzleDb) => T) => {
			const stmts = fn(renderDb);
			for (const s of stmts) {
				// biome-ignore lint/plugin: drizzle's `BatchItem`/`Stmt` carries `.toSQL()` at runtime but doesn't expose it on the type; render it to assert the built SQL.
				const renderable = s as unknown as {toSQL: () => {sql: string; params: unknown[]}};
				captured.push(renderable.toSQL());
			}
			// The method reads only `.meta.changes`; the real `BatchResult` shape is not
			// reconstructable in a no-engine double.
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
		"the SAME guarded UPDATE stamps promoted_at (#1590) — both promotion paths funnel through `promoteToYazar`, so this is the single stamp site for mod-direct AND vouch-tandem",
		() => {
			const cap = capturingBatch(1);
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				yield* pasaport.promoteToYazar({userId: "u-caylak"});

				const tier = cap.statements()[0];
				assert.isTrue(tier !== undefined);
				if (tier === undefined) return;
				const sql = tier.sql.toLowerCase();
				assert.match(sql, /set[\s\S]*"promoted_at"\s*=\s*\?/); // stamps promoted_at…
				assert.match(sql, /where[\s\S]*"tier"/); // …only when the tier actually flips (guarded)

				// It must also be the ONLY statement touching promoted_at, or an unconditional
				// write would stamp on a non-promoting call.
				const stmtsTouchingPromotedAt = cap
					.statements()
					.filter((s) => s.sql.toLowerCase().includes("promoted_at"));
				assert.strictEqual(stmtsTouchingPromotedAt.length, 1);
			}).pipe(Effect.provide(pasaportOver(cap.access)));
		},
	);

	it.effect(
		"a non-promoting call (already-yazar / unknown) leaves promoted_at null — the only promoted_at write is the guarded UPDATE that matched 0 rows",
		() => {
			// 0 = the guarded tier UPDATE matched no rows (already yazar).
			const cap = capturingBatch(0);
			return Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				const {promoted} = yield* pasaport.promoteToYazar({userId: "u-yazar-already"});
				assert.isFalse(promoted);

				const promotedAtWrites = cap
					.statements()
					.filter((s) => s.sql.toLowerCase().includes("promoted_at"));
				assert.strictEqual(promotedAtWrites.length, 1); // exactly one write site…
				assert.match(promotedAtWrites[0]?.sql.toLowerCase() ?? "", /where[\s\S]*"tier"/); // …and it is tier-guarded, so 0-row matches stamp nothing
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
