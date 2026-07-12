/**
 * sözlük backstop-reconciliation → the AC5 end-to-end guard for #2558.
 *
 * The gap (#2558): the remove/restore + create ceremony SWALLOWS-and-logs a cache-refresh die
 * (`swallowRefresh`, #2012 — the substrate write already committed, so a recomputable-cache die
 * must not 500 the request). That swallow is correct and stays. But the convergence contract is
 * only "heals on the NEXT write", and no reconciliation job existed — so a low-traffic term whose
 * LAST write's refresh died stayed stale indefinitely (wrong `definition_count`/`total_score`/
 * `excerpt`, stale `term_search` FTS row, drifted `sozluk_stats`), invisible to Sentry. The fix
 * is `Sozluk.reconcileCaches` (`Sozluk.ts`), driven periodically by a cron trigger
 * (`sozluk-reconcile-cron.ts`): re-run the convergent cache refresh for EVERY term.
 *
 * The pure sweep control flow (`scanReconcileChunks`) is unit-tested off-DB
 * (`sozluk-reconcile-scan.unit.test.ts`). This is the integration tier AC5 names (ADR 0082
 * §irreducible-integration): the real re-derivation from `definition_record` → the `term_record`
 * + `sozluk_stats` write-back that the unit test can't reach. It:
 *   1. seeds a real term with one definition over the PUBLIC fate seam (`seedTerm`), which
 *      converges `term_record` (`definition_count = 1`) and `sozluk_stats`;
 *   2. constructs the exact #2558 stale state via setup-only D1 writes (`execD1`) — the divergence
 *      a swallowed last-write refresh leaves: `term_record` corrupted to a WRONG summary
 *      (`definition_count = 99`, a bogus `excerpt`) and `sozluk_stats.total_definitions` drifted to
 *      999, while the underlying `definition_record` (the source of truth) is untouched;
 *   3. runs the REAL `Sozluk.reconcileCaches(now)` against this stage's REAL remote D1 (the
 *      fts-backfill / hot-decay precedent, #645/#2027: the SHIPPED service over `@kampus/d1-rest`,
 *      never a `node:sqlite` oracle — banned by ADR 0082 — and never a re-implementation of the
 *      fold; `SozlukLive` built over the real D1 with inert Vote/Reaction/Pasaport stubs, since
 *      the reconcile path touches none of them);
 *   4. asserts `term_record` re-converged to the TRUE summary (`definition_count = 1`, the real
 *      definition's excerpt, not the bogus one) and `sozluk_stats.total_definitions` back to 1 —
 *      the staleness healed with NO user write.
 *
 * There is no HTTP route to trigger the cron on a deployed worker (the scheduled handler fires on
 * Cloudflare's schedule, not on demand), so — like `fts-backfill` / `pano-hot-score-decay` — the
 * test drives the real method directly against this stage's real D1 REST target. Per-file
 * `integrationStack`: this file owns its own worker + D1, so the direct-D1 reconcile and the
 * seeded rows see one isolated table (and `sozluk_stats` counts only this file's definitions).
 */
import {makeD1RestFromEnv} from "@kampus/d1-rest";
import {eq} from "drizzle-orm";
import {type Context, Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, Drizzle, makeDrizzleAccess, orDieAccess} from "../../worker/db/Drizzle.ts";
import * as schema from "../../worker/db/drizzle/schema.ts";
import {PasaportIdentityStub} from "../../worker/features/pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../../worker/features/reaction/Reaction.testing.ts";
import {Sozluk, SozlukLive} from "../../worker/features/sozluk/Sozluk.ts";
import {Vote} from "../../worker/features/vote/Vote.ts";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const SLUG = `reconcile-${Date.now().toString(36)}`;
const TITLE = "Reconcile Term";
const DEF_BODY = "the one true live definition body for the reconcile term";

// reconcileCaches touches only `run`/`batch` (persistTermSummary + recomputeSozlukStats), never
// Vote/Reaction/Pasaport — so inert stubs satisfy the layer without an implementation.
const inertVote = Layer.succeed(Vote, {} as Context.Service.Shape<typeof Vote>);

/**
 * Build the REAL `Sozluk` service bound to this stage's REAL remote D1 over `@kampus/d1-rest`
 * — the shipped worker code path (`createDrizzle` → `makeDrizzleAccess` → `SozlukLive`), never a
 * re-implementation of its fold. Returns a runner for `reconcileCaches` plus a `read` escape hatch
 * that runs a select against the same real D1 for the assertions.
 */
async function realSozluk() {
	const target = await h.d1Target();
	const db = createDrizzle(makeD1RestFromEnv(target));
	const access = orDieAccess(makeDrizzleAccess(db));
	const sozlukLayer = SozlukLive.pipe(
		Layer.provide(Layer.succeed(Drizzle, makeDrizzleAccess(db))),
		Layer.provide(inertVote),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
	);
	const reconcile = (now: Date) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.reconcileCaches(now);
			}).pipe(Effect.provide(sozlukLayer)),
		);
	const read = <A>(fn: (a: typeof access) => Effect.Effect<A>) => Effect.runPromise(fn(access));
	return {reconcile, read};
}

const readTerm = (s: Awaited<ReturnType<typeof realSozluk>>) =>
	s.read((a) =>
		a.run((db) =>
			db.select().from(schema.termRecord).where(eq(schema.termRecord.slug, SLUG)).get(),
		),
	);

const readStats = (s: Awaited<ReturnType<typeof realSozluk>>) =>
	s.read((a) =>
		a.run((db) => db.select().from(schema.sozlukStats).where(eq(schema.sozlukStats.id, 1)).get()),
	);

beforeAll(async () => {
	const seeded = await h.seedTerm({
		slug: SLUG,
		title: TITLE,
		definitions: [{authorName: "reconcile-yazar", body: DEF_BODY}],
	});
	expect(seeded.insertedDefinitions).toBe(1);
});

describe("sözlük backstop-reconciliation (#2558 AC5) — a swallowed-refresh stale term re-converges", () => {
	it("reconcileCaches re-derives term_record + sozluk_stats from definition_record, healing staleness with no user write", async () => {
		const s = await realSozluk();

		// The seeded true state: one live definition ⇒ term_record.definition_count == 1.
		const seededTerm = await readTerm(s);
		expect(seededTerm?.definitionCount).toBe(1);
		const trueExcerpt = seededTerm?.excerpt;
		expect(trueExcerpt).toBeTruthy();

		// Construct the exact #2558 stale state the swallowed last-write refresh leaves: the
		// summary caches diverge from the (untouched) definition_record source of truth. This is
		// the setup-only fault-injection the public seam can't reach — the swallowed refresh means
		// term_record/sozluk_stats never caught up to a committed definition write.
		const staleTerm = await h.execD1(
			"UPDATE term_record SET definition_count = ?, total_score = ?, excerpt = ? WHERE slug = ?",
			[99, 99, "STALE-SWALLOWED-REFRESH", SLUG],
		);
		expect(staleTerm).toBe(1);
		const staleStats = await h.execD1(
			"UPDATE sozluk_stats SET total_definitions = ? WHERE id = 1",
			[999],
		);
		expect(staleStats).toBe(1);

		// Pre-reconcile: the corrupted summary is what a read now surfaces — the bug state.
		const before = await readTerm(s);
		expect(before?.definitionCount).toBe(99);
		expect(before?.excerpt).toBe("STALE-SWALLOWED-REFRESH");
		const statsBefore = await readStats(s);
		expect(statsBefore?.totalDefinitions).toBe(999);

		// Run the REAL reconcile against real remote D1 — the shipped full sweep + write-back.
		const result = await s.reconcile(new Date());
		expect(result.scanned).toBeGreaterThanOrEqual(1); // the seeded term is swept

		// Post-reconcile: term_record re-derived from the untouched definition_record — the true
		// count and excerpt are back, the bogus values gone. The staleness healed with NO user
		// write (no add/edit/vote happened between the corruption and here).
		const after = await readTerm(s);
		expect(after?.definitionCount).toBe(1);
		expect(after?.excerpt).toBe(trueExcerpt);
		expect(after?.excerpt).not.toBe("STALE-SWALLOWED-REFRESH");

		// And the stats leg re-converged too: total_definitions back to the one seeded live def.
		const statsAfter = await readStats(s);
		expect(statsAfter?.totalDefinitions).toBe(1);
	});
});
