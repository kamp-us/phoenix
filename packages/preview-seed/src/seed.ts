/**
 * The seed core: given a `D1Database`-shaped binding, write the fixture set as
 * idempotent upserts. This is pure of *transport* — it runs identically against
 * an in-memory `node:sqlite` D1 (the unit test) and a Cloudflare D1 REST adapter
 * (the bin), because both satisfy the same `D1Database` surface drizzle drives.
 *
 * Idempotency (AC: "safely re-runnable"): every insert is an
 * `onConflictDoUpdate` keyed on the row's primary key, so a second run overwrites
 * the same fixed-identity rows rather than duplicate-key-crashing. The whole set
 * is one D1 `batch` — all rows land or none do.
 */
import {drizzle} from "drizzle-orm/d1";
import {buildFixtures} from "./fixtures.ts";
import {definitionView, postSummary, seedSchema, termSummary} from "./schema.ts";

export type SeedDb = ReturnType<typeof drizzle<typeof seedSchema>>;

export const makeSeedDb = (d1: D1Database): SeedDb => drizzle(d1, {schema: seedSchema});

/** How many rows of each kind the seed wrote — surfaced by the bin for a legible CI log. */
export interface SeedReport {
	readonly terms: number;
	readonly definitions: number;
	readonly posts: number;
}

/**
 * Build the upsert statements for `db` from the fixture set. Split out from
 * {@link seed} so the unit test can assert on the statement set without a live
 * batch, and so the batch tuple is constructed in exactly one place.
 */
export const buildSeedStatements = (db: SeedDb, now?: Date) => {
	const {terms, definitions, posts} = buildFixtures(now);

	const termStmts = terms.map((row) =>
		db.insert(termSummary).values(row).onConflictDoUpdate({target: termSummary.slug, set: row}),
	);
	const defStmts = definitions.map((row) =>
		db.insert(definitionView).values(row).onConflictDoUpdate({target: definitionView.id, set: row}),
	);
	const postStmts = posts.map((row) =>
		db.insert(postSummary).values(row).onConflictDoUpdate({target: postSummary.id, set: row}),
	);

	const statements = [...termStmts, ...defStmts, ...postStmts];
	return {
		statements,
		report: {terms: terms.length, definitions: definitions.length, posts: posts.length},
	};
};

/** Write the fixtures to `d1` as one atomic, idempotent batch. Returns the row counts written. */
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
