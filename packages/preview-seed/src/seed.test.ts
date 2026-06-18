/**
 * Seed I/O against a real in-memory SQLite D1 — runs the production drizzle
 * inserts and asserts the rows the unauth e2e specs read actually land, that the
 * top definition sorts first (the `--top` card), that the post is addressable by
 * id (the /pano/<id> permalink), and that a second run is a clean no-op (the
 * idempotency AC).
 */
import {assert, describe, it} from "@effect/vitest";
import {desc, eq, isNull, sql} from "drizzle-orm";
import {toRestParams} from "./d1-rest.ts";
import {SEED_POST_ID, SEED_TERM_SLUG} from "./fixtures.ts";
import {definitionView, postSummary, termSummary} from "./schema.ts";
import {buildSeedStatements, makeSeedDb, seed} from "./seed.ts";
import {makeSeedTestDb} from "./sqlite-d1.testing.ts";

describe("seed — writes the rows the unauth specs read", () => {
	it("/sozluk lists the seeded term row", async () => {
		const {d1, close} = makeSeedTestDb();
		try {
			await seed(d1);
			const db = makeSeedDb(d1);
			const terms = await db.select().from(termSummary);
			assert.isAtLeast(terms.length, 1);
			assert.isTrue(terms.some((t) => t.slug === SEED_TERM_SLUG && t.title.length > 0));
		} finally {
			close();
		}
	});

	it("/sozluk/<slug> has ≥1 non-deleted definition, top one sorts first", async () => {
		const {d1, close} = makeSeedTestDb();
		try {
			await seed(d1);
			const db = makeSeedDb(d1);
			// The exact read the term page does: WHERE term_slug = ? AND deleted_at IS NULL,
			// ORDER BY score DESC, created_at ASC, id ASC. First row gets `--top`.
			const defs = await db
				.select()
				.from(definitionView)
				.where(
					sql`${definitionView.termSlug} = ${SEED_TERM_SLUG} and ${definitionView.deletedAt} is null`,
				)
				.orderBy(desc(definitionView.score), definitionView.createdAt, definitionView.id);
			assert.isAtLeast(defs.length, 1);
			// The top card is the highest-scoring definition.
			const maxScore = Math.max(...defs.map((d) => d.score));
			assert.strictEqual(defs[0]?.score, maxScore);
			assert.isTrue((defs[0]?.body.length ?? 0) > 0);
		} finally {
			close();
		}
	});

	it("/pano lists the seeded post; it is addressable by id (the permalink target)", async () => {
		const {d1, close} = makeSeedTestDb();
		try {
			await seed(d1);
			const db = makeSeedDb(d1);
			const live = await db.select().from(postSummary).where(isNull(postSummary.deletedAt));
			assert.isAtLeast(live.length, 1);
			const byId = await db.select().from(postSummary).where(eq(postSummary.id, SEED_POST_ID));
			assert.strictEqual(byId.length, 1);
			assert.isTrue((byId[0]?.title.length ?? 0) > 0);
		} finally {
			close();
		}
	});
});

describe("seed — REST-wire-valid params (D1 REST rejects null params)", () => {
	// The in-memory node:sqlite fake binds a null param fine, so the unit suite missed that
	// @distilled.cloud/cloudflare's queryDatabase validates `params` as strict string[] and
	// rejects a null element (`SchemaError: Expected string, got null`) — the seed died on a
	// real D1 before writing anything (#569). Pin the wire contract: no statement may bind a
	// null/undefined param (numbers are fine — toRestParams stringifies them). This fails on
	// the old fixtures (post bound url:null/host:null) and passes once they're omitted so
	// drizzle inlines a literal NULL instead of binding one.
	it("no statement binds a null/undefined param, and each batch survives toRestParams", () => {
		const {d1, close} = makeSeedTestDb();
		try {
			const {statements} = buildSeedStatements(makeSeedDb(d1));
			assert.isAtLeast(statements.length, 1);
			statements.forEach((stmt, i) => {
				const {params} = stmt.toSQL();
				params.forEach((p, j) => {
					assert.isNotNull(
						p,
						`batch[${i}].params[${j}] is null — D1 REST params is strict string[]`,
					);
					assert.notTypeOf(p, "undefined", `batch[${i}].params[${j}] is undefined`);
				});
				// toRestParams is the exact REST-wire transform; it must yield a clean string[].
				const wire = toRestParams(params);
				wire.forEach((w, j) => {
					assert.typeOf(w, "string", `batch[${i}] wire param[${j}] must be a string`);
				});
			});
		} finally {
			close();
		}
	});
});

describe("seed — idempotency (safely re-runnable)", () => {
	it("a second run does not error and does not duplicate rows", async () => {
		const {d1, close} = makeSeedTestDb();
		try {
			const first = await seed(d1);
			const second = await seed(d1); // must not duplicate-key-crash
			assert.deepStrictEqual(first, second);

			// Re-run wrote no extra rows: the row count still equals the fixture set.
			const db = makeSeedDb(d1);
			const termRows = await db.select().from(termSummary);
			const defRows = await db.select().from(definitionView);
			const postRows = await db.select().from(postSummary);
			assert.strictEqual(termRows.length, first.terms);
			assert.strictEqual(defRows.length, first.definitions);
			assert.strictEqual(postRows.length, first.posts);
		} finally {
			close();
		}
	});
});
