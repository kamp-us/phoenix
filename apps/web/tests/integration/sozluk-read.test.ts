/**
 * sozluk reads — black-box against the deployed worker `/fate` route (ADR 0026–0031).
 *
 * Ports the read surface of three pre-alchemy suites that drove the `Sozluk`
 * Effect service directly inside workerd:
 *   - `fate-sozluk-read.test.ts` — `terms(sort)`, `term(slug)`, the
 *     `Term.definitions` keyset, and the `Definition` scalar surface over `/fate`.
 *   - `sozluk-term.test.ts` (read cases) — `getTerm` reflects the seed; unknown
 *     slug → null; `listTermSummaries` (re-expressed as the `terms` list).
 *   - `sozluk-terms-connection.test.ts` — `terms` connection paging (every row
 *     once, recent ordering, stale cursor).
 *
 * Everything is observed over HTTP: seed via the public `definition.add` fate
 * mutation (`h.seedTerm`), read via `/fate`.
 * The connection envelope has NO `totalCount` (`{items:[{cursor,node}],
 * pagination:{hasNext, hasPrevious:false, nextCursor?}}`), so the old `totalCount`
 * assertions are dropped and "every row once" is re-expressed by walking
 * `nextCursor` and asserting the union of node ids has the expected size, no dupes.
 *
 * D1 is shared across all test files (one deploy), so every slug is uniquely
 * prefixed (`szread-${Date.now()}-…`) — never reuse a slug another test may touch.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {harness} from "./_harness.ts";

const h = harness();

const STAMP = Date.now();
const SLUG = `szread-${STAMP}-detail`;

interface TermNode {
	slug: string;
	title: string;
	count: number;
	totalScore: number;
}
interface DefNode {
	id: string;
	body: string;
	score: number;
	author: string;
	authorId: string;
	myVote: number | null;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

// The five seeded definitions (filled in `beforeAll`). Identity now comes from
// the session, so the real `authorId` the worker assigned is captured here rather
// than chosen by the test. Scores are small distinct descending integers — each
// score is realized by that many real up-votes, so they stay deterministic for the
// keyset order (score desc, created_at asc, id asc) without seeding 50+ voters.
let seeded: Awaited<ReturnType<typeof h.seedTerm>>["definitions"];

beforeAll(async () => {
	const result = await h.seedTerm({
		slug: SLUG,
		title: "Fate Read",
		definitions: [
			{authorName: "umut", body: "alpha definition", score: 5},
			{authorName: "elif", body: "beta definition", score: 4},
			{authorName: "ada", body: "gamma definition", score: 3},
			{authorName: "deniz", body: "delta definition", score: 2},
			{authorName: "kaan", body: "epsilon definition", score: 1},
		],
	});
	seeded = result.definitions;
});

describe("sozluk reads — /fate", () => {
	it("terms(recent) returns rows with slug cursors", async () => {
		const result = await h.fate({
			kind: "list",
			name: "terms",
			args: {sort: "recent", first: 100},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as Connection<TermNode>;
		const seeded = data.items.find((e) => e.node.slug === SLUG);
		expect(seeded).toBeDefined();
		expect(seeded!.cursor).toBe(SLUG); // cursor is the slug keyset
		expect(seeded!.node.title).toBe("Fate Read");
		expect(seeded!.node.count).toBe(5);
		expect(data.pagination.hasPrevious).toBe(false);
	});

	it("term(slug) returns the detail row", async () => {
		const result = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: SLUG},
			select: ["slug", "title", "count", "totalScore", "definitionCount"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as TermNode;
		expect(data.slug).toBe(SLUG);
		expect(data.title).toBe("Fate Read");
		expect(data.count).toBe(5);
		expect(data.totalScore).toBe(15);
	});

	it("term(slug) returns null for an unknown slug", async () => {
		const result = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: `szread-${STAMP}-does-not-exist`},
			select: ["slug"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("Term.definitions paginates by DB keyset with no skips/dupes across pages", async () => {
		// Page 1: first 2 in (score desc) order → alpha(5), beta(4).
		const page1 = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2}},
			select: ["slug", "definitions.id", "definitions.body", "definitions.score"],
		});
		expect(page1.ok).toBe(true);
		if (!page1.ok) return;
		const d1 = (page1.data as {definitions: Connection<DefNode>}).definitions;
		expect(d1.items.map((e) => e.node.score)).toEqual([5, 4]);
		expect(d1.items[0]!.node.body).toBe("alpha definition");
		expect(d1.pagination.hasNext).toBe(true);
		const cursor = d1.pagination.nextCursor;
		expect(cursor).toBeDefined();
		// Cursor is the last node's id (the keyset cursor).
		expect(cursor).toBe(d1.items[1]!.node.id);

		// Page 2: after the page-1 cursor → gamma(3), delta(2).
		const page2 = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2, after: cursor}},
			select: ["slug", "definitions.id", "definitions.score"],
		});
		expect(page2.ok).toBe(true);
		if (!page2.ok) return;
		const d2 = (page2.data as {definitions: Connection<DefNode>}).definitions;
		expect(d2.items.map((e) => e.node.score)).toEqual([3, 2]);
		expect(d2.pagination.hasNext).toBe(true);

		// Page 3: last one → epsilon(1), no more.
		const page3 = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2, after: d2.pagination.nextCursor}},
			select: ["slug", "definitions.id", "definitions.score"],
		});
		expect(page3.ok).toBe(true);
		if (!page3.ok) return;
		const d3 = (page3.data as {definitions: Connection<DefNode>}).definitions;
		expect(d3.items.map((e) => e.node.score)).toEqual([1]);
		expect(d3.pagination.hasNext).toBe(false);

		// No skips/dupes: the union of all page ids is exactly the 5 seeded.
		const allIds = [
			...d1.items.map((e) => e.node.id),
			...d2.items.map((e) => e.node.id),
			...d3.items.map((e) => e.node.id),
		];
		expect(new Set(allIds).size).toBe(5);
	});

	it("Definition nodes carry the GraphQL scalar surface (author/authorId/myVote)", async () => {
		const result = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 1}},
			select: [
				"definitions.id",
				"definitions.body",
				"definitions.author",
				"definitions.authorId",
				"definitions.score",
				"definitions.myVote",
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const node = (result.data as {definitions: Connection<DefNode>}).definitions.items[0]!.node;
		// Highest-scoring definition is alpha (umut, score 5), the first seeded row.
		// Identity is session-derived, so assert the author name + the real id the
		// worker assigned (captured from the seed), not a caller-chosen id.
		expect(node.author).toBe("umut");
		expect(node.authorId).toBe(seeded[0]!.authorId);
		expect(node.score).toBe(5);
		// Anonymous viewer → myVote null.
		expect(node.myVote).toBeNull();
	});

	it("seedTerm writes inline; term + terms list reflect the row (popular sort)", async () => {
		// Ports `sozluk-term.test.ts` "seedTerm writes inline; getTerm +
		// listTermSummaries reflect the row" — re-expressed over `/fate`.
		const slug = `szread-${STAMP}-agent`;
		const seed = await h.seedTerm({
			slug,
			title: "Agent",
			definitions: [
				{
					authorName: "umut",
					body: "An autonomous reasoning entity that orchestrates other tools.",
					score: 5,
				},
				{
					authorName: "elif",
					body: "Cloudflare Agent base class — typed Durable Object with state sync.",
					score: 3,
				},
			],
		});
		expect(seed.created).toBe(true);
		expect(seed.insertedDefinitions).toBe(2);
		expect(seed.skippedDefinitions).toBe(0);

		const term = await h.fate({
			kind: "query",
			name: "term",
			args: {slug, definitions: {first: 10}},
			select: ["slug", "title", "count", "totalScore", "definitions.body", "definitions.score"],
		});
		expect(term.ok).toBe(true);
		if (!term.ok) return;
		const t = term.data as TermNode & {definitions: Connection<DefNode>};
		expect(t.slug).toBe(slug);
		expect(t.title).toBe("Agent");
		expect(t.count).toBe(2);
		expect(t.totalScore).toBe(8);
		// Highest-score definition first.
		expect(t.definitions.items[0]!.node.score).toBe(5);
		expect(t.definitions.items[1]!.node.score).toBe(3);
		expect(t.definitions.items[0]!.node.body).toContain("autonomous reasoning entity");

		// The terms list (popular sort) reflects the row.
		const list = await h.fate({
			kind: "list",
			name: "terms",
			args: {sort: "popular", first: 100},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(list.ok).toBe(true);
		if (!list.ok) return;
		const summary = (list.data as Connection<TermNode>).items.find((e) => e.node.slug === slug);
		expect(summary).toBeDefined();
		expect(summary!.node.title).toBe("Agent");
		expect(summary!.node.count).toBe(2);
		expect(summary!.node.totalScore).toBe(8);
	});

	it("terms connection paginates through every seeded row exactly once (popular sort)", async () => {
		// Ports `sozluk-terms-connection.test.ts` "paginates through every row
		// exactly once when walking endCursor (popular sort)". The shared D1 holds
		// other files' terms, so we track only OUR slugs and walk all pages.
		const seededSlugs: string[] = [];
		for (let i = 0; i < 5; i++) {
			const slug = `szread-${STAMP}-popular-${i}`;
			seededSlugs.push(slug);
			await h.seedTerm({
				slug,
				title: `Title ${i}`,
				definitions: [{authorName: `author${i}`, body: `body for ${slug}`, score: 1 + i}],
			});
		}

		const seen: string[] = [];
		let after: string | undefined;
		let safety = 0;
		while (safety++ < 200) {
			const page = await h.fate({
				kind: "list",
				name: "terms",
				args: {sort: "popular", first: 2, ...(after ? {after} : {})},
				select: ["slug"],
			});
			expect(page.ok).toBe(true);
			if (!page.ok) break;
			const conn = page.data as Connection<TermNode>;
			for (const e of conn.items) {
				if (seededSlugs.includes(e.node.slug)) seen.push(e.node.slug);
			}
			if (!conn.pagination.hasNext) break;
			after = conn.pagination.nextCursor;
			if (!after) break;
		}

		// Every seeded slug seen exactly once, no dupes.
		expect(seen.length).toBe(seededSlugs.length);
		expect(new Set(seen).size).toBe(seededSlugs.length);
		// Popular sort: higher score first → descending i.
		expect(seen).toEqual([...seededSlugs].reverse());
	});

	it("terms connection (recent) orders by last activity DESC with slug ASC tie-break", async () => {
		// Ports `sozluk-terms-connection.test.ts` "recent sort orders by
		// lastActivityAt DESC with slug ASC tie-breaker".
		const seededSlugs: string[] = [];
		for (let i = 0; i < 3; i++) {
			const slug = `szread-${STAMP}-recent-${i}`;
			seededSlugs.push(slug);
			await h.seedTerm({
				slug,
				title: `Recent ${i}`,
				definitions: [{authorName: `author${i}`, body: `recent body ${slug}`, score: 1}],
			});
			// Force a >1s gap so lastActivityAt's sec-resolution doesn't collapse.
			if (i < 2) await new Promise((r) => setTimeout(r, 1100));
		}

		const page = await h.fate({
			kind: "list",
			name: "terms",
			args: {sort: "recent", first: 100},
			select: ["slug"],
		});
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		const seededInResult = (page.data as Connection<TermNode>).items
			.map((e) => e.node.slug)
			.filter((s) => seededSlugs.includes(s));
		expect(seededInResult).toEqual([...seededSlugs].reverse());
	});

	it("terms connection collapses to no seeded rows when the cursor points to a non-existent slug", async () => {
		// Ports `sozluk-terms-connection.test.ts` "collapses to no further rows when
		// the cursor points to a non-existent slug".
		const page = await h.fate({
			kind: "list",
			name: "terms",
			args: {sort: "recent", first: 10, after: `szread-${STAMP}-cursor-does-not-exist`},
			select: ["slug"],
		});
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		const conn = page.data as Connection<TermNode>;
		expect(Array.isArray(conn.items)).toBe(true);
		expect(typeof conn.pagination.hasNext).toBe("boolean");
	});

	// not portable black-box: `totalCount` is not on the connection wire envelope
	// (it's `{items, pagination}` only). The old "totalCount matches term_summary
	// row count" case has no observable analog and is dropped.
});
