/**
 * Seed I/O against **real remote Cloudflare D1** (ADR 0082 integration tier) —
 * runs the production `seed(d1)` over the shipped REST transport (`makeD1Rest`,
 * the bin's path) against a per-file isolated, migrated D1 (`_d1.ts`), and asserts:
 *
 *   - the rows the unauthenticated read e2e specs sample actually land — the term
 *     row, the term page's top-definition sort, the /pano/<id> permalink target;
 *   - the FTS5 dual-write is *findable on D1's own FTS5* — exact-title MATCH, the
 *     Turkish İ/ı fold, a short prefix, and no duplicate index rows on re-seed.
 *     This is precisely why these assertions are integration, not unit: node:sqlite's
 *     FTS5 build/tokenizer/collation are NOT D1's (ADR 0082), so a fold "proven" on
 *     the deleted fake proved nothing about D1;
 *   - the seed is idempotent — a second run is a clean no-op (same report, same counts).
 *
 * Pure-logic invariants (fixture content, the REST-wire param contract) stay in the
 * unit tier (`src/*.unit.test.ts`); they need no DB.
 *
 * Locally (no Cloudflare creds) the `beforeAll` deploy stops at `Unauthorized` —
 * expected; this tier proves itself on CI's integration job.
 */

import {normalizeSearchText, toMatchExpression} from "@kampus/web/features/search/normalize";
import {desc, eq, isNull, sql} from "drizzle-orm";
import {beforeAll, describe, expect, it} from "vitest";
import {
	SEARCH_TERM_SLUG,
	SEARCH_TERM_TITLE,
	SEED_POST_ID,
	SEED_TERM_SLUG,
} from "../../src/fixtures.ts";
import {definitionRecord, postRecord, termRecord} from "../../src/schema.ts";
import {makeSeedDb, type SeedReport, seed} from "../../src/seed.ts";
import {seedD1} from "./_d1.ts";

const h = seedD1(import.meta.url);

// One seed for the whole file (the seed is a single fixed-identity fixture set; every
// read assertion is against the same landed rows). The idempotency block re-seeds and
// asserts the no-op, so it does its own second write.
let report: SeedReport;
beforeAll(async () => {
	report = await seed(h.seedDb());
});

const matchTermSlugs = async (
	db: ReturnType<typeof makeSeedDb>,
	query: string,
): Promise<string[]> => {
	const match = toMatchExpression(query);
	expect(match).not.toBeNull();
	const rows = await db.all<{slug: string}>(
		sql`SELECT slug FROM term_search WHERE term_search MATCH ${match}`,
	);
	return rows.map((r) => r.slug);
};

describe("seed — writes the rows the unauth specs read (real D1)", () => {
	it("/sozluk lists the seeded term row", async () => {
		const db = makeSeedDb(h.seedDb());
		const terms = await db.select().from(termRecord);
		expect(terms.length).toBeGreaterThanOrEqual(1);
		expect(terms.some((t) => t.slug === SEED_TERM_SLUG && t.title.length > 0)).toBe(true);
	});

	it("/sozluk/<slug> has ≥1 non-deleted definition, top one sorts first", async () => {
		const db = makeSeedDb(h.seedDb());
		// The exact read the term page does: WHERE term_slug = ? AND removed_at IS NULL,
		// ORDER BY score DESC, created_at ASC, id ASC. First row gets `--top`.
		const defs = await db
			.select()
			.from(definitionRecord)
			.where(
				sql`${definitionRecord.termSlug} = ${SEED_TERM_SLUG} and ${definitionRecord.removedAt} is null`,
			)
			.orderBy(desc(definitionRecord.score), definitionRecord.createdAt, definitionRecord.id);
		expect(defs.length).toBeGreaterThanOrEqual(1);
		const maxScore = Math.max(...defs.map((d) => d.score));
		expect(defs[0]?.score).toBe(maxScore);
		expect((defs[0]?.body.length ?? 0) > 0).toBe(true);
	});

	it("/pano lists the seeded post; it is addressable by id (the permalink target)", async () => {
		const db = makeSeedDb(h.seedDb());
		const live = await db.select().from(postRecord).where(isNull(postRecord.removedAt));
		expect(live.length).toBeGreaterThanOrEqual(1);
		const byId = await db.select().from(postRecord).where(eq(postRecord.id, SEED_POST_ID));
		expect(byId.length).toBe(1);
		expect((byId[0]?.title.length ?? 0) > 0).toBe(true);
	});
});

describe("seed — FTS index on D1's own FTS5 (24-search; ADR 0080)", () => {
	// Asserting the seeded term is FOUND by the exact MATCH the search resolver runs
	// (bm25 over term_search, joined back by slug) proves the seed's dual-write produced
	// a `norm` that a real D1 query matches (#534) — on D1's FTS5, not a fake's.
	it("a seeded term's exact title finds its row (appears)", async () => {
		const slugs = await matchTermSlugs(makeSeedDb(h.seedDb()), SEED_TERM_SLUG.replace(/-/g, " "));
		expect(slugs).toContain(SEED_TERM_SLUG);
	});

	it("the İ/ı term matches its uppercase Turkish casing variant (the fold crux)", async () => {
		const db = makeSeedDb(h.seedDb());
		const variant = SEARCH_TERM_TITLE.toLocaleUpperCase("tr"); // "ışık" → "IŞIK"
		expect(variant).not.toBe(SEARCH_TERM_TITLE);
		expect(normalizeSearchText(variant)).toBe(normalizeSearchText(SEARCH_TERM_TITLE));
		expect(await matchTermSlugs(db, variant)).toContain(SEARCH_TERM_SLUG);
	});

	it("a short prefix of a seeded title matches (prefix indexing)", async () => {
		expect(await matchTermSlugs(makeSeedDb(h.seedDb()), "mer")).toContain(SEED_TERM_SLUG);
	});

	it("re-seeding does not duplicate FTS rows (idempotent dual-write)", async () => {
		// Re-seed (the dual-write is delete-then-insert keyed on slug), then assert the
		// term appears exactly once in the FTS index.
		await seed(h.seedDb());
		const db = makeSeedDb(h.seedDb());
		const slugs = await matchTermSlugs(db, SEED_TERM_SLUG.replace(/-/g, " "));
		expect(slugs.filter((s) => s === SEED_TERM_SLUG).length).toBe(1);
	});
});

describe("seed — idempotency on real D1 (safely re-runnable)", () => {
	it("a second run does not error and does not duplicate rows", async () => {
		const second = await seed(h.seedDb()); // must not duplicate-key-crash
		expect(second).toStrictEqual(report);

		// Re-run wrote no extra rows: each count still equals the fixture set the first
		// run reported.
		const db = makeSeedDb(h.seedDb());
		const termRows = await db.select().from(termRecord);
		const defRows = await db.select().from(definitionRecord);
		const postRows = await db.select().from(postRecord);
		expect(termRows.length).toBe(report.terms);
		expect(defRows.length).toBe(report.definitions);
		expect(postRows.length).toBe(report.posts);
	});
});
