/**
 * site-search integration — the real FTS5 fidelity the unit tier cannot prove
 * (ADR 0080 dual-write, ADR 0082 two-tier). Black-box over the deployed worker's
 * `/fate` route via `searchTerms` / `searchPosts`, seeded through the PUBLIC
 * Sozluk/Pano write paths so the dual-write FTS sync is what populates the index —
 * the assertions exercise the end-to-end write→FTS-sync→search loop, not a
 * hand-seeded FTS table.
 *
 * This is the real-D1 residue of the retired `worker/features/fate/search.test.ts`
 * `makeSqliteTestDb` suite (#579). The *pure* halves of that suite moved DOWN to
 * `unit`, where they belong and are already proven with no SQL engine:
 *   - Turkish diacritic/dotted-`i` folding + min-length → `normalizeSearchText` /
 *     `toMatchExpression` in `worker/features/search/normalize.unit.test.ts`.
 *   - cursor-miss → empty-page decision → `resolveCursor` in
 *     `worker/db/keyset.unit.test.ts`.
 * What stays here is everything that could only be wrong if the real FTS5 engine
 * differed: bm25 rank order, prefix/`MATCH` honoring, the dual-write sync loop,
 * soft-delete/retitle re-index, title-only scope, and the min-length boundary as
 * it hits the real `searchTerms` op.
 *
 * Each file owns its own per-file isolated stage + D1 (ADR 0082), but seeds still
 * carry a unique stamp so a `NO_DESTROY` re-run never collides with a prior run's
 * rows.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now();

interface TermNode {
	slug: string;
	title: string;
}
interface PostNode {
	id: string;
	title: string;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

async function searchTerms(args: Record<string, unknown>): Promise<Connection<TermNode>> {
	const res = await h.fate({kind: "list", name: "searchTerms", args, select: ["slug", "title"]});
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error(`searchTerms failed: ${res.error.code}`);
	return res.data as Connection<TermNode>;
}

async function searchPosts(args: Record<string, unknown>): Promise<Connection<PostNode>> {
	const res = await h.fate({kind: "list", name: "searchPosts", args, select: ["id", "title"]});
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error(`searchPosts failed: ${res.error.code}`);
	return res.data as Connection<PostNode>;
}

let author: {userId: string; cookie: string};

beforeAll(async () => {
	author = await h.signUp(`search-${STAMP}-author@test.local`, "hunter2hunter2", "yazar");
});

/** Submit a post under the author cookie; assert success; return its id. */
async function seedPost(title: string): Promise<string> {
	const r = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error(`seedPost failed: ${r.error.code}`);
	return (r.data as PostNode).id;
}

describe("searchTerms — real FTS5 over the deployed worker", () => {
	// Distinct slug prefixes per concern so one describe's fixtures never leak into
	// another's result set (the index is shared within the file's single stage).
	const istanbulSlug = `search-${STAMP}-istanbul`;
	const sisliSlug = `search-${STAMP}-sisli`;
	const ankaraSlug = `search-${STAMP}-ankara`;

	beforeAll(async () => {
		await h.seedTerm({
			slug: istanbulSlug,
			title: "İstanbul",
			definitions: [{authorName: "yazar", body: "İstanbul gövde"}],
		});
		await h.seedTerm({
			slug: sisliSlug,
			title: "Şişli",
			definitions: [{authorName: "yazar", body: "Şişli gövde"}],
		});
		await h.seedTerm({
			slug: ankaraSlug,
			title: "Ankara",
			definitions: [{authorName: "yazar", body: "Ankara gövde"}],
		});
	});

	it("an ASCII query matches a diacritic/dotted-i title through the normalized index", async () => {
		// "istanbul" (ASCII) hits "İstanbul" and "sisli" hits "Şişli" only because the
		// app-side normalized column is what FTS5 indexes — unicode61's ASCII-wrong
		// case-fold is sidestepped. (The fold itself is unit-proven in
		// normalize.unit.test.ts; this proves the engine matches over the folded text.)
		const c1 = await searchTerms({query: "istanbul"});
		expect(c1.items.map((e) => e.node.slug)).toEqual([istanbulSlug]);

		const c2 = await searchTerms({query: "sisli"});
		expect(c2.items.map((e) => e.node.slug)).toEqual([sisliSlug]);
	});

	it("prefix-matches (poor-man's stemmer) via FTS5 MATCH and excludes non-matching terms", async () => {
		const c = await searchTerms({query: "ist"});
		expect(c.items.map((e) => e.node.slug)).toEqual([istanbulSlug]);
		expect(c.items.find((e) => e.node.slug === ankaraSlug)).toBeUndefined();
		expect(c.items.find((e) => e.node.slug === sisliSlug)).toBeUndefined();
	});

	it("a below-min-length query returns an empty connection (not everything)", async () => {
		// The resolver short-circuits (toMatchExpression → null) before touching FTS5;
		// this asserts that boundary as the real `searchTerms` op serves it end-to-end.
		const c = await searchTerms({query: "i"});
		expect(c.items).toEqual([]);
		expect(c.pagination.hasNext).toBe(false);
	});
});

describe("searchTerms — bm25-ranked keyset pagination over real FTS5", () => {
	const projectSlugs = [
		`search-${STAMP}-proje-a`,
		`search-${STAMP}-proje-b`,
		`search-${STAMP}-proje-c`,
	];

	beforeAll(async () => {
		// Three terms sharing the common token "ortak" so bm25 ties make the slug-asc
		// tiebreaker order the page deterministically across the cursor walk.
		await h.seedTerm({
			slug: projectSlugs[0]!,
			title: "ortak proje a",
			definitions: [{authorName: "yazar", body: "ortak proje a gövde"}],
		});
		await h.seedTerm({
			slug: projectSlugs[1]!,
			title: "ortak proje b",
			definitions: [{authorName: "yazar", body: "ortak proje b gövde"}],
		});
		await h.seedTerm({
			slug: projectSlugs[2]!,
			title: "ortak proje c",
			definitions: [{authorName: "yazar", body: "ortak proje c gövde"}],
		});
	});

	it("the cursor round-trips to the next page with no skips or dupes", async () => {
		const p1 = await searchTerms({query: "ortak", first: 2});
		expect(p1.items.length).toBe(2);
		expect(p1.pagination.hasNext).toBe(true);
		const after = p1.pagination.nextCursor;
		expect(after).toBeDefined();

		const p2 = await searchTerms({query: "ortak", first: 2, after});
		const all = [...p1.items, ...p2.items].map((e) => e.node.slug);
		expect(all).toEqual(projectSlugs);
		expect(new Set(all).size).toBe(3);
		expect(p2.pagination.hasNext).toBe(false);
	});
});

describe("searchPosts — FTS5 sync, soft-delete and retitle re-index", () => {
	it("matches post titles and drops a deleted post from the index", async () => {
		const keepId = await seedPost(`Yazılım mimarisi ${STAMP}a`);
		const dropId = await seedPost(`Yazılım testleri ${STAMP}a`);

		const before = await searchPosts({query: "yazilim"});
		const beforeIds = before.items.map((e) => e.node.id);
		expect(beforeIds).toContain(keepId);
		expect(beforeIds).toContain(dropId);

		const del = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id: dropId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);

		const after = await searchPosts({query: "yazilim"});
		const afterIds = after.items.map((e) => e.node.id);
		expect(afterIds).toContain(keepId);
		expect(afterIds).not.toContain(dropId);
	});

	it("a retitled post is re-indexed under its new title (and drops its old title)", async () => {
		const id = await seedPost(`Eskimola ${STAMP}b`);
		const before = await searchPosts({query: "eskimola"});
		expect(before.items.map((e) => e.node.id)).toContain(id);

		const edit = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, title: `Yenimola ${STAMP}b`},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(edit.ok).toBe(true);

		const stale = await searchPosts({query: "eskimola"});
		expect(stale.items.map((e) => e.node.id)).not.toContain(id);
		const fresh = await searchPosts({query: "yenimola"});
		expect(fresh.items.map((e) => e.node.id)).toContain(id);
	});
});

describe("searchTerms — title-only scope (guards against scope creep)", () => {
	it("excludes a term whose query appears only in its definition body, never the title", async () => {
		// Scope v1 is titles only: "gövde" appears in every seeded definition body but
		// never in a title, so a body-only query must return nothing — the real FTS5
		// index proves the body is not part of the term search document.
		await h.seedTerm({
			slug: `search-${STAMP}-kavram`,
			title: "Kavram",
			definitions: [{authorName: "yazar", body: "Kavram gövde"}],
		});
		const c = await searchTerms({query: "govde"});
		expect(c.items).toEqual([]);
	});
});
