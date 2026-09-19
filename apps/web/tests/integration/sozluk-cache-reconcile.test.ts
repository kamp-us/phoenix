/**
 * sözlük backstop-reconciliation — the end-to-end guard for #2558: a term whose LAST write's
 * cache refresh was swallowed (`swallowRefresh`, #2012) stayed stale forever, because the
 * convergence contract only promised "heals on the NEXT write". `Sozluk.reconcileCaches` is the
 * cron-driven backstop. The pure sweep control flow is unit-tested off-DB in
 * `sozluk-reconcile-scan.unit.test.ts`; this is the irreducible-integration half (ADR 0082).
 *
 * No HTTP route triggers the cron on a deployed worker, so — like `fts-backfill` /
 * `pano-hot-score-decay` (#645/#2027) — the test drives the shipped method directly against this
 * stage's real D1, never a `node:sqlite` oracle (banned by ADR 0082) and never a re-implementation
 * of the fold. Per-file `integrationStack`, so `sozluk_stats` counts only this file's definitions.
 *
 * The same sweep is #9331's declared backfill route for `term_record.first_letter`, so the second
 * suite below rides it: correcting the derivation alone leaves every untouched row stale forever,
 * because `recomputeTermSummary` runs only on a definition write.
 */
import {eq} from "drizzle-orm";
import {type Context, Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, Drizzle, makeDrizzleAccess, orDieAccess} from "../../worker/db/Drizzle.ts";
import * as schema from "../../worker/db/drizzle/schema.ts";
import {PasaportIdentityStub} from "../../worker/features/pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../../worker/features/reaction/Reaction.testing.ts";
import {Sozluk, SozlukLive} from "../../worker/features/sozluk/Sozluk.ts";
import {Vote} from "../../worker/features/vote/Vote.ts";
import {makeIntegrationD1Rest} from "./_cf-rest-transport.ts";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const SLUG = `reconcile-${Date.now().toString(36)}`;
const TITLE = "Reconcile Term";
const DEF_BODY = "the one true live definition body for the reconcile term";

/**
 * The #9331 backfill subjects. Each pair is `[slug, title]` where the slug is the ASCII fold —
 * so the letter the pre-fix code stored (the slug's head) differs from the letter the headword
 * actually files under. `w` has no Turkish letter at all and must land on `""`.
 */
const LETTER_STAMP = Date.now().toString(36);
const LETTER_TERMS: ReadonlyArray<readonly [slug: string, title: string, letter: string]> = [
	[`onbellek-${LETTER_STAMP}`, "önbellek", "ö"],
	[`isik-${LETTER_STAMP}`, "ışık", "ı"],
	[`webhook-${LETTER_STAMP}`, "webhook", ""],
];

// reconcileCaches touches only `run`/`batch` (persistTermSummary + recomputeSozlukStats), never
// Vote/Reaction/Pasaport — so inert stubs satisfy the layer without an implementation.
const inertVote = Layer.succeed(Vote, {} as Context.Service.Shape<typeof Vote>);

/** The shipped `Sozluk` code path bound to this stage's real remote D1, plus a read hatch. */
async function realSozluk() {
	const target = await h.d1Target();
	const db = createDrizzle(makeIntegrationD1Rest(target));
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

const readTermBySlug = (s: Awaited<ReturnType<typeof realSozluk>>, slug: string) =>
	s.read((a) =>
		a.run((db) =>
			db.select().from(schema.termRecord).where(eq(schema.termRecord.slug, slug)).get(),
		),
	);

const readTerm = (s: Awaited<ReturnType<typeof realSozluk>>) => readTermBySlug(s, SLUG);

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

	for (const [slug, title] of LETTER_TERMS) {
		const row = await h.seedTerm({
			slug,
			title,
			definitions: [{authorName: "reconcile-yazar", body: `${title} icin tohum tanim`}],
		});
		expect(row.insertedDefinitions).toBe(1);
	}
});

describe("sözlük backstop-reconciliation (#2558 AC5) — a swallowed-refresh stale term re-converges", () => {
	it("reconcileCaches re-derives term_record + sozluk_stats from definition_record, healing staleness with no user write", async () => {
		const s = await realSozluk();

		const seededTerm = await readTerm(s);
		expect(seededTerm?.definitionCount).toBe(1);
		const trueExcerpt = seededTerm?.excerpt;
		expect(trueExcerpt).toBeTruthy();

		// Setup-only fault injection the public seam can't reach: the summary caches diverge
		// from the untouched definition_record, exactly as a swallowed last-write refresh leaves
		// them.
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

		const before = await readTerm(s);
		expect(before?.definitionCount).toBe(99);
		expect(before?.excerpt).toBe("STALE-SWALLOWED-REFRESH");
		const statsBefore = await readStats(s);
		expect(statsBefore?.totalDefinitions).toBe(999);

		const result = await s.reconcile(new Date());
		expect(result.scanned).toBeGreaterThanOrEqual(1);

		// Healed with NO user write: nothing added, edited or voted since the corruption.
		const after = await readTerm(s);
		expect(after?.definitionCount).toBe(1);
		expect(after?.excerpt).toBe(trueExcerpt);
		expect(after?.excerpt).not.toBe("STALE-SWALLOWED-REFRESH");

		// One definition per seeded term, and `LETTER_TERMS` adds its own to this file's stage.
		const statsAfter = await readStats(s);
		expect(statsAfter?.totalDefinitions).toBe(1 + LETTER_TERMS.length);
	});
});

describe("term_record.first_letter backfill (#9331) — one reconcile pass corrects every row", () => {
	it("re-derives the stored letter from the headword, so pre-fix ASCII-folded rows converge", async () => {
		const s = await realSozluk();

		// The pre-fix state, written the way the pre-fix code wrote it: `first_letter` is the
		// slug's head, and the slug is the ASCII fold. `önbellek` files under `o`, `ışık` under
		// `i`, `webhook` under `w` — a letter the alphabet does not index at all.
		for (const [slug] of LETTER_TERMS) {
			const rows = await h.execD1("UPDATE term_record SET first_letter = ? WHERE slug = ?", [
				slug.charAt(0),
				slug,
			]);
			expect(rows).toBe(1);
		}
		for (const [slug] of LETTER_TERMS) {
			expect((await readTermBySlug(s, slug))?.firstLetter).toBe(slug.charAt(0));
		}

		// ONE full pass. `reconcileCaches` walks every term slug in chunks and re-runs
		// `persistTermSummary`, so it is the backfill route — there is no separate script.
		const result = await s.reconcile(new Date());
		expect(result.scanned).toBeGreaterThanOrEqual(LETTER_TERMS.length);

		for (const [slug, title, letter] of LETTER_TERMS) {
			const row = await readTermBySlug(s, slug);
			expect(row?.title).toBe(title);
			expect(row?.firstLetter).toBe(letter);
		}
	});
});
