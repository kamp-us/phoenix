/**
 * The seed core: given a `D1Database`-shaped binding, write the fixture set as
 * idempotent upserts. Transport-free on purpose — statement-building resolves
 * SQL+params off an inert `D1Database` with no engine (the unit test), while the
 * bin runs the same writes over the Cloudflare D1 REST adapter.
 *
 * Safely re-runnable: every insert is an `onConflictDoUpdate` on the row's
 * primary key, and the whole set is one D1 `batch` — all rows land or none do.
 */
import {normalizeSearchText} from "@kampus/web/features/search/normalize";
import {eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {buildFixtures} from "./fixtures.ts";
import {
	definitionRecord,
	postRecord,
	postSearch,
	seedSchema,
	termRecord,
	termSearch,
} from "./schema.ts";

// RQB v2 (drizzle 1.0): drizzle() takes `relations`, not `schema` (ADR: #727). This
// seed runs no relational `.with` traversal, so empty `defineRelations(seedSchema)` just
// registers the tables — mirrors apps/web worker/db/Drizzle.ts.
const relations = defineRelations(seedSchema);

export type SeedDb = ReturnType<typeof drizzle<typeof relations>>;

export const makeSeedDb = (d1: D1Database): SeedDb => drizzle(d1, {relations});

export interface SeedReport {
	readonly terms: number;
	readonly definitions: number;
	readonly posts: number;
	readonly termsFts: number;
	readonly postsFts: number;
}

/** Split out from {@link seed} so the unit test can assert the statement set with no live batch. */
export const buildSeedStatements = (db: SeedDb, now?: Date) => {
	const {terms, definitions, posts} = buildFixtures(now);

	const termStmts = terms.map((row) =>
		db.insert(termRecord).values(row).onConflictDoUpdate({target: termRecord.slug, set: row}),
	);
	const defStmts = definitions.map((row) =>
		db
			.insert(definitionRecord)
			.values(row)
			.onConflictDoUpdate({target: definitionRecord.id, set: row}),
	);
	const postStmts = posts.map((row) =>
		db.insert(postRecord).values(row).onConflictDoUpdate({target: postRecord.id, set: row}),
	);

	// FTS dual-write (ADR 0080): index each seeded title into term_search / post_search
	// as a delete-then-insert keyed on slug/id — the same upsert shape the worker's
	// `syncTermSearch`/`syncPostSearch` produce (FTS5 has no ON CONFLICT). The `norm`
	// is the worker's OWN `normalizeSearchText`, so a seeded term's index value
	// byte-matches what a real query normalizes to and is searchable (#534).
	const termFtsStmts = terms.flatMap((row) => [
		db.delete(termSearch).where(eq(termSearch.slug, row.slug)),
		db.insert(termSearch).values({slug: row.slug, norm: normalizeSearchText(row.title)}),
	]);
	const postFtsStmts = posts.flatMap((row) => [
		db.delete(postSearch).where(eq(postSearch.id, row.id)),
		db.insert(postSearch).values({id: row.id, norm: normalizeSearchText(row.title)}),
	]);

	const statements = [...termStmts, ...defStmts, ...postStmts, ...termFtsStmts, ...postFtsStmts];
	return {
		statements,
		report: {
			terms: terms.length,
			definitions: definitions.length,
			posts: posts.length,
			termsFts: terms.length,
			postsFts: posts.length,
		},
	};
};

export const seed = async (d1: D1Database, now?: Date): Promise<SeedReport> => {
	const db = makeSeedDb(d1);
	const {statements, report} = buildSeedStatements(db, now);
	// D1 `batch` rejects an empty tuple; the fixture set is never empty, but keep
	// the non-empty assertion explicit for the type.
	const [first, ...rest] = statements;
	if (first === undefined) return report;
	await db.batch([first, ...rest]);
	return report;
};
