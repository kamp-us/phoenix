/**
 * fate bridge — sozluk keyset correctness (T2).
 *
 * The keyset-ordering + pagination correctness for sozluk reads, migrated down
 * from the integration (T3) suite (`tests/integration/sozluk-read.test.ts`). T3
 * drove this through HTTP sign-up + real `definition.add`/`definition.vote`
 * mutations to realize scores, with a `sleep(1100)` to space `last_activity_at`
 * across its second-resolution — a flake engine. Here the fixtures are seeded by
 * **direct INSERT** with explicit `score` / `createdAt` / `id` / `lastActivityAt`
 * values, so the keyset tie-breaks are deterministic with no clock, no votes, and
 * no sleep. Same coverage, no flake.
 *
 * The three keysets under test (read off `Sozluk.ts`):
 *   - `Term.definitions` → `(score desc, created_at asc, id asc)`, cursor = def id.
 *   - `terms(sort: "popular")` → `(total_score desc, slug asc)`, cursor = slug.
 *   - `terms(sort: "recent")`  → `(last_activity_at desc, slug asc)`, cursor = slug.
 *
 * Each fixture deliberately plants ties straddling a page boundary so the
 * lower-priority keyset column is the only thing that orders the rows correctly.
 *
 * Idiom follows `bridge-sozluk.test.ts`: per-test fresh `node:sqlite` D1 +
 * `WorkerLive` layer, direct Drizzle INSERT seeding, `runFateOp` to drive `/fate`.
 */
import {Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Database} from "../../db/Database";
import {createDrizzle} from "../../db/Drizzle";
import * as schema from "../../db/drizzle/schema";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.testing";
import {layerStub} from "../pasaport/better-auth.testing";
import {makeFateLayer, type WorkerFateServices} from "./layers";
import {runFateOp} from "./run-fate-op";

/** The wire connection envelope (`{items, pagination}` — no `totalCount`). */
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};
interface DefNode {
	id: string;
	score: number;
	body: string;
}
interface TermNode {
	slug: string;
	title: string;
	count: number;
	totalScore: number;
}

let sqlite: SqliteD1;
let WorkerLive: Layer.Layer<WorkerFateServices>;

beforeEach(() => {
	sqlite = makeSqliteTestDb();
	WorkerLive = makeFateLayer.pipe(
		Layer.provide(Layer.merge(Layer.succeed(Database)(sqlite.d1), layerStub())),
	);
});

afterEach(() => {
	sqlite?.close();
});

/** Seed one definition_view row. `createdAt`/`id` drive the keyset tie-breaks. */
interface DefSeed {
	id: string;
	score: number;
	body: string;
	createdAt: Date;
}
async function seedTerm(opts: {
	slug: string;
	title: string;
	defs: DefSeed[];
	/** Overrides the derived `last_activity_at` (for the recent-sort tie-break). */
	lastActivityAt?: Date;
}): Promise<void> {
	const db = createDrizzle(sqlite.d1);
	await db.insert(schema.definitionView).values(
		opts.defs.map((d) => ({
			id: d.id,
			authorId: "u-author",
			authorName: "author",
			termSlug: opts.slug,
			termTitle: opts.title,
			body: d.body,
			bodyExcerpt: d.body,
			score: d.score,
			createdAt: d.createdAt,
			updatedAt: d.createdAt,
			deletedAt: null,
			lastEventId: "",
		})),
	);
	const totalScore = opts.defs.reduce((s, d) => s + d.score, 0);
	const now = new Date();
	await db.insert(schema.termSummary).values({
		slug: opts.slug,
		title: opts.title,
		firstLetter: opts.slug.charAt(0),
		definitionCount: opts.defs.length,
		totalScore,
		excerpt: opts.defs[0]?.body ?? null,
		topDefinitionId: opts.defs[0]?.id ?? null,
		firstAt: now,
		lastActivityAt: opts.lastActivityAt ?? now,
		lastEditAt: now,
		lastEventId: "",
	});
}

describe("fate bridge — sozluk keyset (Term.definitions)", () => {
	// Five definitions exercising every tie the keyset (score desc, created_at
	// asc, id asc) must break:
	//   - def-a score 50, earliest  → rank 1
	//   - def-b score 40, t=2000    → score tie with def-c, broken by created_at
	//   - def-c score 40, t=3000    → later than def-b → rank 3
	//   - def-d score 30, t=4000    → full (score, created_at) tie with def-e,
	//   - def-e score 30, t=4000    → broken by id asc (def-d < def-e) → rank 5
	// page size 2 puts the score tie (b/c) at the page-1→2 boundary and the
	// id-only tie (d/e) at the page-2→3 boundary.
	const SLUG = "keyset-defs";
	const t = (ms: number) => new Date(ms);
	beforeEach(async () => {
		await seedTerm({
			slug: SLUG,
			title: "Keyset Defs",
			defs: [
				{id: "def-a", score: 50, body: "a", createdAt: t(1000)},
				{id: "def-b", score: 40, body: "b", createdAt: t(2000)},
				{id: "def-c", score: 40, body: "c", createdAt: t(3000)},
				{id: "def-d", score: 30, body: "d", createdAt: t(4000)},
				{id: "def-e", score: 30, body: "e", createdAt: t(4000)},
			],
		});
	});

	it("paginates by the (score desc, created_at asc, id asc) keyset with no skips/dupes", async () => {
		const order = ["def-a", "def-b", "def-c", "def-d", "def-e"];

		// Page 1: a(50), b(40 @2000) — the score tie boundary lands here.
		const p1 = await runFateOp(WorkerLive, {
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2}},
			select: ["definitions.id", "definitions.score"],
		});
		expect(p1.result.ok).toBe(true);
		if (!p1.result.ok) return;
		const d1 = (p1.result.data as {definitions: Connection<DefNode>}).definitions;
		expect(d1.items.map((e) => e.node.id)).toEqual(["def-a", "def-b"]);
		expect(d1.pagination.hasNext).toBe(true);
		// Cursor is the last node's id (the keyset cursor).
		expect(d1.pagination.nextCursor).toBe("def-b");

		// Page 2: c(40 @3000), d(30 @4000) — c follows b on created_at asc.
		const p2 = await runFateOp(WorkerLive, {
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2, after: d1.pagination.nextCursor}},
			select: ["definitions.id", "definitions.score"],
		});
		expect(p2.result.ok).toBe(true);
		if (!p2.result.ok) return;
		const d2 = (p2.result.data as {definitions: Connection<DefNode>}).definitions;
		expect(d2.items.map((e) => e.node.id)).toEqual(["def-c", "def-d"]);
		expect(d2.pagination.hasNext).toBe(true);
		expect(d2.pagination.nextCursor).toBe("def-d");

		// Page 3: e(30 @4000) — the (score, created_at) tie with def-d is broken by
		// id asc, so def-e is last; no more after it.
		const p3 = await runFateOp(WorkerLive, {
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2, after: d2.pagination.nextCursor}},
			select: ["definitions.id", "definitions.score"],
		});
		expect(p3.result.ok).toBe(true);
		if (!p3.result.ok) return;
		const d3 = (p3.result.data as {definitions: Connection<DefNode>}).definitions;
		expect(d3.items.map((e) => e.node.id)).toEqual(["def-e"]);
		expect(d3.pagination.hasNext).toBe(false);
		// A final NON-empty page still carries the last row's cursor as endCursor
		// (the connection envelope emits `nextCursor` whenever a row exists); only
		// `hasNext: false` signals the end. A stale-cursor empty page is the case
		// where `nextCursor` is absent (see below).
		expect(d3.pagination.nextCursor).toBe("def-e");

		// No skips/dupes across pages, and the union is exactly the seeded order.
		const all = [...d1.items, ...d2.items, ...d3.items].map((e) => e.node.id);
		expect(all).toEqual(order);
		expect(new Set(all).size).toBe(order.length);
	});

	it("collapses to an empty page when the definitions cursor is a non-existent id", async () => {
		const res = await runFateOp(WorkerLive, {
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2, after: "def-does-not-exist"}},
			select: ["definitions.id"],
		});
		expect(res.result.ok).toBe(true);
		if (!res.result.ok) return;
		const conn = (res.result.data as {definitions: Connection<DefNode>}).definitions;
		expect(conn.items).toEqual([]);
		expect(conn.pagination.hasNext).toBe(false);
		expect(conn.pagination.nextCursor).toBeUndefined();
	});
});

describe("fate bridge — sozluk keyset (terms popular sort)", () => {
	// Six terms exercising the (total_score desc, slug asc) keyset, including a
	// score tie (pop-c / pop-d both 30) straddling the page-2→3 boundary so the
	// slug-asc tiebreak is the only thing ordering them:
	//   pop-a 50, pop-b 40, pop-c 30, pop-d 30, pop-e 20, pop-f 10
	// page size 2 → [a,b] [c,d] [e,f]; within the tie c precedes d by slug asc.
	beforeEach(async () => {
		const fixtures: Array<[string, number]> = [
			["pop-a", 50],
			["pop-b", 40],
			["pop-c", 30],
			["pop-d", 30],
			["pop-e", 20],
			["pop-f", 10],
		];
		for (const [slug, score] of fixtures) {
			await seedTerm({
				slug,
				title: slug.toUpperCase(),
				defs: [{id: `${slug}-def`, score, body: `body ${slug}`, createdAt: new Date(1000)}],
			});
		}
	});

	it("orders popular by (total_score desc, slug asc) across pages with no skips/dupes", async () => {
		const expected = ["pop-a", "pop-b", "pop-c", "pop-d", "pop-e", "pop-f"];
		const seen: string[] = [];
		let after: string | undefined;
		let safety = 0;
		while (safety++ < 50) {
			const page = await runFateOp(WorkerLive, {
				kind: "list",
				name: "terms",
				args: {sort: "popular", first: 2, ...(after ? {after} : {})},
				select: ["slug", "totalScore"],
			});
			expect(page.result.ok).toBe(true);
			if (!page.result.ok) return;
			const conn = page.result.data as Connection<TermNode>;
			for (const e of conn.items) seen.push(e.node.slug);
			// Each item's cursor is its slug (the keyset key).
			for (const e of conn.items) expect(e.cursor).toBe(e.node.slug);
			if (!conn.pagination.hasNext) break;
			after = conn.pagination.nextCursor;
			expect(after).toBeDefined();
		}
		expect(seen).toEqual(expected);
		expect(new Set(seen).size).toBe(expected.length);
	});

	it("a popular page reports endCursor/hasNext mid-walk and the tiebreak holds at the boundary", async () => {
		// Page 2 is [pop-c, pop-d] — the score-tie pair. endCursor must be the last
		// row's slug and hasNext must still be true (pop-e/pop-f remain).
		const p1 = await runFateOp(WorkerLive, {
			kind: "list",
			name: "terms",
			args: {sort: "popular", first: 2},
			select: ["slug"],
		});
		expect(p1.result.ok).toBe(true);
		if (!p1.result.ok) return;
		const c1 = p1.result.data as Connection<TermNode>;
		expect(c1.items.map((e) => e.node.slug)).toEqual(["pop-a", "pop-b"]);
		expect(c1.pagination.hasNext).toBe(true);
		expect(c1.pagination.nextCursor).toBe("pop-b");

		const p2 = await runFateOp(WorkerLive, {
			kind: "list",
			name: "terms",
			args: {sort: "popular", first: 2, after: c1.pagination.nextCursor},
			select: ["slug"],
		});
		expect(p2.result.ok).toBe(true);
		if (!p2.result.ok) return;
		const c2 = p2.result.data as Connection<TermNode>;
		// Tie broken by slug asc → pop-c then pop-d.
		expect(c2.items.map((e) => e.node.slug)).toEqual(["pop-c", "pop-d"]);
		expect(c2.pagination.hasNext).toBe(true);
		expect(c2.pagination.nextCursor).toBe("pop-d");
	});
});

describe("fate bridge — sozluk keyset (terms recent sort)", () => {
	// Recent orders by (last_activity_at desc, slug asc). Seed explicit
	// last_activity_at values (no clock, no sleep): rec-a is newest, rec-b and
	// rec-c share a timestamp so the slug-asc tiebreak orders them, rec-d oldest.
	const at = (ms: number) => new Date(ms);
	beforeEach(async () => {
		const fixtures: Array<[string, number]> = [
			["rec-a", 4000],
			["rec-b", 3000],
			["rec-c", 3000],
			["rec-d", 2000],
		];
		for (const [slug, ms] of fixtures) {
			await seedTerm({
				slug,
				title: slug.toUpperCase(),
				defs: [{id: `${slug}-def`, score: 1, body: `body ${slug}`, createdAt: new Date(1000)}],
				lastActivityAt: at(ms),
			});
		}
	});

	it("orders recent by (last_activity_at desc, slug asc) with the tiebreak at a page boundary", async () => {
		// Full list first: newest-first, ties broken by slug asc.
		const all = await runFateOp(WorkerLive, {
			kind: "list",
			name: "terms",
			args: {sort: "recent", first: 100},
			select: ["slug"],
		});
		expect(all.result.ok).toBe(true);
		if (!all.result.ok) return;
		const conn = all.result.data as Connection<TermNode>;
		expect(conn.items.map((e) => e.node.slug)).toEqual(["rec-a", "rec-b", "rec-c", "rec-d"]);

		// Paged: page size 2 puts the last_activity_at tie (rec-b/rec-c) on the
		// page-1→2 boundary; slug asc must still order them rec-b then rec-c.
		const p1 = await runFateOp(WorkerLive, {
			kind: "list",
			name: "terms",
			args: {sort: "recent", first: 2},
			select: ["slug"],
		});
		expect(p1.result.ok).toBe(true);
		if (!p1.result.ok) return;
		const c1 = p1.result.data as Connection<TermNode>;
		expect(c1.items.map((e) => e.node.slug)).toEqual(["rec-a", "rec-b"]);
		expect(c1.pagination.hasNext).toBe(true);
		expect(c1.pagination.nextCursor).toBe("rec-b");

		const p2 = await runFateOp(WorkerLive, {
			kind: "list",
			name: "terms",
			args: {sort: "recent", first: 2, after: c1.pagination.nextCursor},
			select: ["slug"],
		});
		expect(p2.result.ok).toBe(true);
		if (!p2.result.ok) return;
		const c2 = p2.result.data as Connection<TermNode>;
		expect(c2.items.map((e) => e.node.slug)).toEqual(["rec-c", "rec-d"]);
		expect(c2.pagination.hasNext).toBe(false);
		// Final non-empty page → endCursor is the last row's slug, hasNext false.
		expect(c2.pagination.nextCursor).toBe("rec-d");
	});

	it("collapses to an empty page when the recent cursor points to a non-existent slug", async () => {
		const page = await runFateOp(WorkerLive, {
			kind: "list",
			name: "terms",
			args: {sort: "recent", first: 10, after: "rec-does-not-exist"},
			select: ["slug"],
		});
		expect(page.result.ok).toBe(true);
		if (!page.result.ok) return;
		const conn = page.result.data as Connection<TermNode>;
		expect(conn.items).toEqual([]);
		expect(conn.pagination.hasNext).toBe(false);
		expect(conn.pagination.nextCursor).toBeUndefined();
	});
});
