/**
 * sözlük keyset EXECUTION verticals on real remote Cloudflare D1 (ADR 0082).
 *
 * The keyset *predicate shape* and the cursor-miss/page-envelope *decision* are
 * pure and unit-tested (`worker/db/keyset.unit.test.ts`: `keysetAfter`,
 * `resolveCursor`, `forwardPage`) — those are deletions from the retired
 * `node:sqlite` fate-op suite, not re-proven here. What stays at `integration`
 * is the irreducible real-D1 core (ADR 0082 "Irreducible integration core"): how
 * the real engine *executes* the keyset — ordering and tie-breaks across page
 * boundaries — plus read-row shaping, the denormalized term_summary counters,
 * and the write→read re-resolve loop.
 *
 * Seeded through the PUBLIC fate seam (`h.seedTerm` → `definition.add` +
 * `definition.vote`), so `score` (vote-derived) and `slug` (caller-chosen) are
 * the deterministically-controllable keyset columns here; the tie-breaks asserted
 * across boundaries are exactly the ones that seam can realize without a direct
 * INSERT. The `recent` keyset's lead column (`last_activity_at`) is server-stamped
 * (`floor(now/1000)`), never settable through the public seam — so the recent
 * vertical CONSTRUCTS its activity order by stamping each row's `last_activity_at`
 * to a fixed whole-second epoch directly (`h.setLastActivityAt`, a controlled D1
 * write), giving the 2/3 pair an identical injected second the engine can only order
 * by slug-asc. The assertions then check the engine honored `(last_activity_at desc,
 * slug asc)` over those injected seconds. No `touchTerm`/`sleep` race remains: against
 * real remote D1 the prior "two adjacent touches share a second" assumption lost on
 * round-trip latency and reddened unrelated PRs (#643). Per-file isolated stage owns
 * its own D1, so files run in parallel; slugs are still process-stamped so a
 * `NO_DESTROY` re-run never collides with a prior run's rows.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now();

interface TermNode {
	slug: string;
	title: string;
	count: number;
	totalScore: number;
	lastActivityAt: string | null;
}
interface DefNode {
	id: string;
	body: string;
	score: number;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

// `terms` popular keyset is `(total_score desc, slug asc)`. Two terms share a
// total_score (a tie straddling a page boundary at page size 2), so slug-asc is
// the only thing ordering them — the vertical the real engine must execute.
// Distinct totals elsewhere pin the primary desc ordering. Scores are realized
// by distinct up-votes, so total_score == sum of definition scores.
const P = `kx${STAMP}p`; // popular-fixture slug prefix (kept short — slugs sort lexicographically)
const POP: Array<[slug: string, score: number]> = [
	[`${P}a`, 5],
	[`${P}b`, 4],
	[`${P}c`, 3], // c/d tie on total_score 3 — slug-asc orders c before d…
	[`${P}d`, 3], // …across the page-2 boundary
	[`${P}e`, 2],
	[`${P}f`, 1],
];

// Term.definitions keyset is `(score desc, created_at asc, id asc)`. Distinct
// scores give a deterministic desc order through the public seam (created_at/id
// tie-breaks need a direct INSERT the seam can't do — those columns' EXECUTION is
// exercised by distinct-score ordering here; the tie-break BRANCH is the pure
// `keysetAfter` shape, unit-tested).
const DEFS_SLUG = `kx${STAMP}defs`;

// `terms(recent)` keyset is `(last_activity_at desc, slug asc)`. `last_activity_at`
// is server-stamped (`recomputeTermSummary` writes `floor(now/1000)`) and never
// settable through the public seam — so the prior fixture seeded four terms and then
// raced two back-to-back touches hoping they'd land in the SAME wall-clock second to
// build the date tie. Against real remote D1 the round-trip latency separates those
// two writes' seconds far more often than not, so that race lost ~deterministically
// and reddened unrelated PRs (#643). Instead, seed the four terms and stamp each row's
// `last_activity_at` to an EXACT whole-second epoch directly (`h.setLastActivityAt`):
// the activity order is CONSTRUCTED, the 2/3 tie is an identical injected second, and
// nothing depends on wall-clock alignment.
const R = `kr${STAMP}`; // recent-fixture slug prefix
const REC_SLUGS = [`${R}1`, `${R}2`, `${R}3`, `${R}4`] as const;

// Fixed activity seconds: 4 newest, 2 == 3 (the injected tie slug-asc must order), 1
// oldest. Anchored to the process stamp so a `NO_DESTROY` re-run's seconds don't alias
// a prior run's rows, and spaced by 10s so the strict steps can't collapse.
const REC_BASE_SEC = Math.floor(STAMP / 1000);
const REC_ACTIVITY_SEC: Record<string, number> = {
	[`${R}1`]: REC_BASE_SEC, // oldest
	[`${R}2`]: REC_BASE_SEC + 10, // tie with 3
	[`${R}3`]: REC_BASE_SEC + 10, // tie with 2
	[`${R}4`]: REC_BASE_SEC + 20, // newest
};

beforeAll(async () => {
	for (const [slug, score] of POP) {
		await h.seedTerm({
			slug,
			title: slug.toUpperCase(),
			definitions: [{authorName: "umut", body: `body ${slug}`, score}],
		});
	}
	await h.seedTerm({
		slug: DEFS_SLUG,
		title: "Keyset Defs",
		definitions: [
			{authorName: "umut", body: "high", score: 5},
			{authorName: "elif", body: "mid", score: 3},
			{authorName: "ada", body: "low", score: 1},
		],
	});

	// Seed the four recent-fixture terms, then stamp each one's `last_activity_at` to
	// its fixed second — no touch, no clock, no race. The 2/3 pair gets an IDENTICAL
	// second, so the only thing that can order them is the engine's slug-asc tiebreak.
	for (const slug of REC_SLUGS) {
		await h.seedTerm({
			slug,
			title: slug.toUpperCase(),
			definitions: [{authorName: "umut", body: `body ${slug}`}],
		});
	}
	for (const slug of REC_SLUGS) {
		await h.setLastActivityAt(slug, REC_ACTIVITY_SEC[slug]!);
	}
});

describe("sözlük keyset execution — real D1 (terms popular)", () => {
	it("orders popular by (total_score desc, slug asc) across pages with no skips/dupes", async () => {
		const expected = POP.map(([slug]) => slug);
		const seen: string[] = [];
		let after: string | undefined;
		let safety = 0;
		while (safety++ < 50) {
			const page = await h.fate({
				kind: "list",
				name: "terms",
				args: {sort: "popular", first: 2, ...(after ? {after} : {})},
				select: ["slug", "totalScore"],
			});
			expect(page.ok).toBe(true);
			if (!page.ok) return;
			const conn = page.data as Connection<TermNode>;
			// Scope to this fixture's prefix — the per-file stage's D1 is isolated, but
			// a NO_DESTROY re-run may carry other terms; the keyset claim is about
			// THESE rows' relative order.
			for (const e of conn.items.filter((x) => x.node.slug.startsWith(P))) {
				seen.push(e.node.slug);
				expect(e.cursor).toBe(e.node.slug); // cursor IS the slug keyset
			}
			if (!conn.pagination.hasNext) break;
			after = conn.pagination.nextCursor;
			expect(after).toBeDefined();
		}
		expect(seen).toEqual(expected);
		expect(new Set(seen).size).toBe(expected.length);
	});

	it("holds the (total_score) tie at a page boundary by slug asc", async () => {
		// Walk straight to the c/d tie pair and assert slug-asc orders them.
		const all = await h.fate({
			kind: "list",
			name: "terms",
			args: {sort: "popular", first: 100},
			select: ["slug", "totalScore"],
		});
		expect(all.ok).toBe(true);
		if (!all.ok) return;
		const ours = (all.data as Connection<TermNode>).items
			.filter((e) => e.node.slug.startsWith(P))
			.map((e) => e.node.slug);
		const c = ours.indexOf(`${P}c`);
		const d = ours.indexOf(`${P}d`);
		expect(c).toBeGreaterThanOrEqual(0);
		expect(d).toBe(c + 1); // the score-3 tie resolves c (slug asc) immediately before d
	});
});

describe("sözlük keyset execution — real D1 (terms recent)", () => {
	// Pull THIS fixture's rows (prefix-scoped) from a recent page, preserving the
	// engine's order, with the `last_activity_at` D1 recorded.
	const recentOurs = async (
		args: {first: number; after?: string} = {first: 100},
	): Promise<{slugs: string[]; rows: TermNode[]; conn: Connection<TermNode>}> => {
		const page = await h.fate({
			kind: "list",
			name: "terms",
			args: {sort: "recent", ...args},
			select: ["slug", "lastActivityAt"],
		});
		expect(page.ok).toBe(true);
		if (!page.ok) throw new Error("recent list failed");
		const conn = page.data as Connection<TermNode>;
		const rows = conn.items.map((e) => e.node).filter((n) => n.slug.startsWith(R));
		return {slugs: rows.map((n) => n.slug), rows, conn};
	};

	it("orders recent by (last_activity_at desc, slug asc) — strict steps + a same-second tie", async () => {
		const {slugs, rows} = await recentOurs();
		expect(new Set(slugs)).toEqual(new Set(REC_SLUGS)); // all four present
		expect(new Set(slugs).size).toBe(REC_SLUGS.length); // no dupes

		// The engine's order must honor the keyset over whatever timestamps D1
		// recorded: `last_activity_at` non-increasing, and any same-second run broken
		// by slug asc. Asserting the INVARIANT (not fixed strings) is clock-robust.
		const sec = (n: TermNode): number => {
			expect(n.lastActivityAt).not.toBeNull();
			return Math.floor(new Date(n.lastActivityAt!).getTime() / 1000);
		};
		for (let i = 1; i < rows.length; i++) {
			const prev = rows[i - 1]!;
			const cur = rows[i]!;
			expect(sec(prev)).toBeGreaterThanOrEqual(sec(cur)); // last_activity_at desc
			if (sec(prev) === sec(cur)) {
				expect(prev.slug < cur.slug).toBe(true); // tie → slug asc
			}
		}

		// The injected activity seconds (1 oldest | 2 == 3 tie | 4 newest) pin a concrete
		// expected order on top of the invariant: 4 (newest) → 2 → 3 (the same-second
		// pair, slug asc) → 1 (oldest).
		expect(slugs).toEqual([`${R}4`, `${R}2`, `${R}3`, `${R}1`]);

		// The 2/3 pair is the date TIE — assert it really shares a second (so the
		// slug-asc ordering above was the engine breaking a genuine tie, not a step).
		const r2 = rows.find((n) => n.slug === `${R}2`)!;
		const r3 = rows.find((n) => n.slug === `${R}3`)!;
		expect(sec(r2)).toBe(sec(r3));
	});

	it("walks recent across the tie boundary with no skips/dupes (cursor = slug)", async () => {
		// Walk the whole recent list in pages of 2, collecting THIS fixture's rows in
		// engine order. Page-prefix-scoped (other terms in D1 may interleave on a
		// NO_DESTROY re-run); the claim is these four rows' relative order + that the
		// 2/3 same-second tie survives whatever page boundary it lands on, resolved
		// slug-asc across the cursor round-trip.
		const seen: string[] = [];
		let after: string | undefined;
		let safety = 0;
		while (safety++ < 50) {
			const {conn} = await recentOurs(after ? {first: 2, after} : {first: 2});
			for (const e of conn.items.filter((x) => x.node.slug.startsWith(R))) {
				seen.push(e.node.slug);
				expect(e.cursor).toBe(e.node.slug); // cursor IS the slug keyset
			}
			if (seen.length >= REC_SLUGS.length || !conn.pagination.hasNext) break;
			after = conn.pagination.nextCursor;
			expect(after).toBeDefined();
		}
		expect(seen).toEqual([`${R}4`, `${R}2`, `${R}3`, `${R}1`]);
		expect(new Set(seen).size).toBe(REC_SLUGS.length); // no skips/dupes across boundaries
	});
});

describe("sözlük keyset execution — real D1 (Term.definitions)", () => {
	it("orders definitions by score desc as the real engine executes the keyset", async () => {
		const res = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: DEFS_SLUG, definitions: {first: 10}},
			select: ["definitions.id", "definitions.body", "definitions.score"],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const conn = (res.data as {definitions: Connection<DefNode>}).definitions;
		expect(conn.items.map((e) => e.node.body)).toEqual(["high", "mid", "low"]);
		expect(conn.items.map((e) => e.node.score)).toEqual([5, 3, 1]);
	});

	it("paginates definitions across a boundary with no skips/dupes", async () => {
		const p1 = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: DEFS_SLUG, definitions: {first: 2}},
			select: ["definitions.id", "definitions.body"],
		});
		expect(p1.ok).toBe(true);
		if (!p1.ok) return;
		const d1 = (p1.data as {definitions: Connection<DefNode>}).definitions;
		expect(d1.items.map((e) => e.node.body)).toEqual(["high", "mid"]);
		expect(d1.pagination.hasNext).toBe(true);

		const p2 = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: DEFS_SLUG, definitions: {first: 2, after: d1.pagination.nextCursor}},
			select: ["definitions.id", "definitions.body"],
		});
		expect(p2.ok).toBe(true);
		if (!p2.ok) return;
		const d2 = (p2.data as {definitions: Connection<DefNode>}).definitions;
		expect(d2.items.map((e) => e.node.body)).toEqual(["low"]);
		expect(d2.pagination.hasNext).toBe(false);

		const all = [...d1.items, ...d2.items].map((e) => e.node.id);
		expect(new Set(all).size).toBe(3); // no dupes across the boundary
	});
});

describe("sözlük read-row shaping + denormalized counters — real D1", () => {
	it("term(slug) serves the aggregate count + totalScore the real engine maintains", async () => {
		const res = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: DEFS_SLUG},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const data = res.data as TermNode;
		expect(data.slug).toBe(DEFS_SLUG);
		expect(data.title).toBe("Keyset Defs");
		expect(data.count).toBe(3); // term_summary.definition_count
		expect(data.totalScore).toBe(9); // 5 + 3 + 1, term_summary.total_score
	});
});

describe("sözlük write→read re-resolve — real D1", () => {
	it("definition.add increments the count and the new row re-resolves on the term page", async () => {
		const slug = `kx${STAMP}rt`;
		const author = await h.signUp(`kx-${STAMP}-rt@seed.local`, "seedpass-seedpass", "writer");

		// `definition.add` is identity-bearing and not auto-retried; it runs under
		// the author's session cookie.
		const add1 = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, termTitle: "Round Trip", body: "first definition"},
				select: ["id", "body"],
			},
			{cookie: author.cookie},
		);
		expect(add1.ok).toBe(true);
		if (!add1.ok) return;

		const t1 = await h.fate({
			kind: "query",
			name: "term",
			args: {slug, definitions: {first: 10}},
			select: ["count", "definitions.id", "definitions.body"],
		});
		expect(t1.ok).toBe(true);
		if (!t1.ok) return;
		const term1 = t1.data as {count: number; definitions: Connection<DefNode>};
		const firstCount = term1.count;
		expect(term1.definitions.items.some((e) => e.node.body === "first definition")).toBe(true);

		const created = (add1.data as {id: string}).id;
		const add2 = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, termTitle: "Round Trip", body: "second definition"},
				select: ["id", "body"],
			},
			{cookie: author.cookie},
		);
		expect(add2.ok).toBe(true);
		if (!add2.ok) return;

		const t2 = await h.fate({
			kind: "query",
			name: "term",
			args: {slug, definitions: {first: 10}},
			select: ["count", "definitions.id", "definitions.body"],
		});
		expect(t2.ok).toBe(true);
		if (!t2.ok) return;
		const term2 = t2.data as {count: number; definitions: Connection<DefNode>};
		expect(term2.count).toBe(firstCount + 1); // counter re-resolved off the new write
		const ids = term2.definitions.items.map((e) => e.node.id);
		expect(ids).toContain(created); // the first write still resolves
		expect(term2.definitions.items.some((e) => e.node.body === "second definition")).toBe(true);
	});
});
