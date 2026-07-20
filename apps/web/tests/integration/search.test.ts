/**
 * site-search integration — the real FTS5 fidelity the unit tier cannot prove
 * (ADR 0080 dual-write, ADR 0082 two-tier). Black-box over the deployed worker's
 * `/fate` route via `searchTerms` / `searchPosts`, seeded through the PUBLIC
 * Sozluk/Pano write paths so the dual-write FTS sync is what populates the index —
 * the assertions exercise the end-to-end write→FTS-sync→search loop, not a
 * hand-seeded FTS table.
 *
 * This is the real-D1 residue of the retired `worker/features/fate/search.test.ts`
 * suite (#579) — which leaned on the now-deleted `makeSqliteTestDb` in-memory
 * `node:sqlite` D1 fake (gone with the four-tier model, ADR 0082; there is no
 * in-memory SQL tier). The *pure* halves of that suite moved DOWN to
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
 * This file runs on its OWN DEDICATED per-file stage (`integrationStack`), NOT the run-scoped
 * SHARED stage — because it does multi-request keyset paging walks (`searchTerms first:2 →
 * cursor → after`) whose lead-sort statistic, bm25 rank, is a CROSS-FILE-GLOBAL corpus
 * statistic (total docs / term frequencies over the whole `term_search` table). On a shared
 * D1 a parallel fork's writes BETWEEN two page requests re-rank the corpus mid-walk, skipping
 * or duping a row across the page boundary (CI: search dropped `proje-c`, `Array(2)` vs
 * `Array(3)`). NS-namespacing scopes a single request's RESULT SET but can't fence a global
 * ranking across requests. A dedicated stage gives a stable corpus across the walk — per
 * ADR 0104, paged-walk files stay dedicated (#1027 over-migrated this one; #1143 reverts it).
 *
 * The per-file `NS` (this file's deterministic `nsToken`) prefixing is retained from the
 * shared-stage migration: harmless on the dedicated D1, and it keeps the fixtures honest.
 * The FTS index is the normalized TITLE (`fts-sync.ts`) and the `MATCH` builder
 * (`normalize.ts`) ANDs each query token's prefix; every seeded title and FTS query carries
 * the same `NS` token. `NS` is pure ASCII `[a-z0-9-]`, so it folds to itself through
 * `normalizeSearchText` and never perturbs the diacritic fold under test (the `istanbul`
 * token still folds to match a dotted-`İ` title independently), and it's added SYMMETRICALLY
 * to all three `ortak` titles, so the bm25 tie — and the slug-asc page order — is preserved.
 *
 * The min-length boundary (`query: "i"`) is the one query left UN-namespaced: it must short-
 * circuit in `toMatchExpression` (normalized length < MIN_QUERY_LENGTH) BEFORE FTS, and
 * prefixing it with `NS` would push it over the min length and defeat the boundary it proves.
 * It returns `[]` via the short-circuit regardless of the corpus, so it stays correct.
 */
import {key, platform} from "@kampus/authz";
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = integrationStack(import.meta.url);

const NS = nsToken(import.meta.url);
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

async function searchPosts(
	args: Record<string, unknown>,
	opts?: {cookie?: string},
): Promise<Connection<PostNode>> {
	const res = await h.fate(
		{kind: "list", name: "searchPosts", args, select: ["id", "title"]},
		opts,
	);
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error(`searchPosts failed: ${res.error.code}`);
	return res.data as Connection<PostNode>;
}

let author: {userId: string; cookie: string};

beforeAll(async () => {
	author = await h.signUpYazar(`${NS}-${STAMP}-author@test.local`, "hunter2hunter2", "anka");
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
	// another's result set. (The `NS`-prefixed title + query also scope every match to
	// this file's rows — retained from the shared-stage era, harmless on the dedicated D1.)
	const istanbulSlug = `${NS}-${STAMP}-istanbul`;
	const sisliSlug = `${NS}-${STAMP}-sisli`;
	const ankaraSlug = `${NS}-${STAMP}-ankara`;

	beforeAll(async () => {
		await h.seedTerm({
			slug: istanbulSlug,
			title: `${NS} İstanbul`,
			definitions: [{authorName: "anka", body: "İstanbul gövde"}],
		});
		await h.seedTerm({
			slug: sisliSlug,
			title: `${NS} Şişli`,
			definitions: [{authorName: "anka", body: "Şişli gövde"}],
		});
		await h.seedTerm({
			slug: ankaraSlug,
			title: `${NS} Ankara`,
			definitions: [{authorName: "anka", body: "Ankara gövde"}],
		});
	});

	it("an ASCII query matches a diacritic/dotted-i title through the normalized index", async () => {
		// "istanbul" (ASCII) hits "İstanbul" and "sisli" hits "Şişli" only because the
		// app-side normalized column is what FTS5 indexes — unicode61's ASCII-wrong
		// case-fold is sidestepped. (The fold itself is unit-proven in
		// normalize.unit.test.ts; this proves the engine matches over the folded text.)
		// The `NS` token only AND-scopes the result set to this file; the diacritic fold
		// still applies to the `istanbul`/`sisli` token against the dotted-İ/Ş title.
		const c1 = await searchTerms({query: `${NS} istanbul`});
		expect(c1.items.map((e) => e.node.slug)).toEqual([istanbulSlug]);

		const c2 = await searchTerms({query: `${NS} sisli`});
		expect(c2.items.map((e) => e.node.slug)).toEqual([sisliSlug]);
	});

	it("prefix-matches (poor-man's stemmer) via FTS5 MATCH and excludes non-matching terms", async () => {
		const c = await searchTerms({query: `${NS} ist`});
		expect(c.items.map((e) => e.node.slug)).toEqual([istanbulSlug]);
		expect(c.items.find((e) => e.node.slug === ankaraSlug)).toBeUndefined();
		expect(c.items.find((e) => e.node.slug === sisliSlug)).toBeUndefined();
	});

	it("a below-min-length query returns an empty connection (not everything)", async () => {
		// The resolver short-circuits (toMatchExpression → null) before touching FTS5;
		// this asserts that boundary as the real `searchTerms` op serves it end-to-end.
		// Left UN-namespaced on purpose: the `NS` prefix would push it over the min length
		// and defeat the short-circuit. It returns `[]` regardless of the corpus.
		const c = await searchTerms({query: "i"});
		expect(c.items).toEqual([]);
		expect(c.pagination.hasNext).toBe(false);
	});
});

describe("searchTerms — bm25-ranked keyset pagination over real FTS5", () => {
	const projectSlugs = [
		`${NS}-${STAMP}-proje-a`,
		`${NS}-${STAMP}-proje-b`,
		`${NS}-${STAMP}-proje-c`,
	];

	beforeAll(async () => {
		// Three terms sharing the common token "ortak" so bm25 ties make the slug-asc
		// tiebreaker order the page deterministically across the cursor walk. The `NS`
		// token is added symmetrically to all three titles, so the bm25 tie (and thus the
		// slug-asc order) is preserved while the result set is scoped to this file.
		await h.seedTerm({
			slug: projectSlugs[0]!,
			title: `${NS} ortak proje a`,
			definitions: [{authorName: "anka", body: "ortak proje a gövde"}],
		});
		await h.seedTerm({
			slug: projectSlugs[1]!,
			title: `${NS} ortak proje b`,
			definitions: [{authorName: "anka", body: "ortak proje b gövde"}],
		});
		await h.seedTerm({
			slug: projectSlugs[2]!,
			title: `${NS} ortak proje c`,
			definitions: [{authorName: "anka", body: "ortak proje c gövde"}],
		});
	});

	it("the cursor round-trips to the next page with no skips or dupes", async () => {
		const p1 = await searchTerms({query: `${NS} ortak`, first: 2});
		expect(p1.items.length).toBe(2);
		expect(p1.pagination.hasNext).toBe(true);
		const after = p1.pagination.nextCursor;
		expect(after).toBeDefined();

		const p2 = await searchTerms({query: `${NS} ortak`, first: 2, after});
		const all = [...p1.items, ...p2.items].map((e) => e.node.slug);
		expect(all).toEqual(projectSlugs);
		expect(new Set(all).size).toBe(3);
		expect(p2.pagination.hasNext).toBe(false);
	});
});

describe("searchPosts — FTS5 sync, soft-delete and retitle re-index", () => {
	it("matches post titles and drops a deleted post from the index", async () => {
		const keepId = await seedPost(`${NS} Yazılım mimarisi ${STAMP}a`);
		const dropId = await seedPost(`${NS} Yazılım testleri ${STAMP}a`);

		const before = await searchPosts({query: `${NS} yazilim`});
		const beforeIds = before.items.map((e) => e.node.id);
		expect(beforeIds).toContain(keepId);
		expect(beforeIds).toContain(dropId);

		const del = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id: dropId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);

		const after = await searchPosts({query: `${NS} yazilim`});
		const afterIds = after.items.map((e) => e.node.id);
		expect(afterIds).toContain(keepId);
		expect(afterIds).not.toContain(dropId);
	});

	it("a retitled post is re-indexed under its new title (and drops its old title)", async () => {
		const id = await seedPost(`${NS} Eskimola ${STAMP}b`);
		const before = await searchPosts({query: `${NS} eskimola`});
		expect(before.items.map((e) => e.node.id)).toContain(id);

		const edit = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, title: `${NS} Yenimola ${STAMP}b`},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(edit.ok).toBe(true);

		const stale = await searchPosts({query: `${NS} eskimola`});
		expect(stale.items.map((e) => e.node.id)).not.toContain(id);
		const fresh = await searchPosts({query: `${NS} yenimola`});
		expect(fresh.items.map((e) => e.node.id)).toContain(id);
	});
});

describe("searchTerms — title-only scope (guards against scope creep)", () => {
	it("excludes a term whose query appears only in its definition body, never the title", async () => {
		// Scope v1 is titles only: "gövde" appears in every seeded definition body but
		// never in a title, so a body-only query must return nothing — the real FTS5
		// index proves the body is not part of the term search document. The `NS` token
		// scopes the (empty) result to this file: no NS-prefixed title carries `govde`.
		await h.seedTerm({
			slug: `${NS}-${STAMP}-kavram`,
			title: `${NS} Kavram`,
			definitions: [{authorName: "anka", body: "Kavram gövde"}],
		});
		const c = await searchTerms({query: `${NS} govde`});
		expect(c.items).toEqual([]);
	});
});

describe("searchPosts — çaylak sandbox read-mask over real FTS5 (#1358 p0 leak)", () => {
	// The end-to-end half of #1358's AC4 that the rendered-SQL unit test cannot give:
	// the mask is `id IN (<visible post_record ids>)`, so only a real FTS5 engine
	// proves a sandboxed row indexed in `post_search` is actually excluded from a
	// non-author/non-moderator viewer's results AND from the keyset/pagination slots
	// (the #1312 count/keyset vector), while staying visible to its author and a mod.
	//
	// A post is sandboxed by stamping `post_record.sandboxed_at` — the column the
	// çaylak write path sets via `sandboxedAtForAuthor` (kunye/sandbox.ts). The çaylak
	// write path has no HTTP handle in the harness, so the sandbox state is minted with
	// a setup-only `execD1` UPDATE:
	// the same off-the-binding real-D1 seam `setLastActivityAt` uses for the
	// server-stamped clock and the founder-seed moderation grant uses for the
	// `moderates` tuple. The row stays FTS-indexed; only the read-time mask hides it —
	// exactly the keyset-filter path AC3 documents.
	const TOKEN = `${NS} mahzen${STAMP}`;
	let liveAId = "";
	let liveBId = "";
	let sandboxedId = "";
	let moderator: {userId: string; cookie: string};
	let other: {userId: string; cookie: string};

	beforeAll(async () => {
		moderator = await h.signUp(`${NS}-${STAMP}-mod@test.local`, "hunter2hunter2", "mod");
		other = await h.signUp(`${NS}-${STAMP}-other@test.local`, "hunter2hunter2", "uye");

		// Grant the moderator platform-moderation authority the prod way — a direct
		// `moderates` / `key(platform)` relation tuple (ADR 0107, the founder-seed mint),
		// so `currentSandboxViewer`'s `Moderate.over(platform)` probe resolves to a Grant.
		await h.execD1("INSERT INTO relation_tuple (subject, relation, object) VALUES (?, ?, ?)", [
			moderator.userId,
			"moderates",
			key(platform),
		]);

		// Two live posts + one to-be-sandboxed, all authored by `author` and all
		// matching TOKEN, so the masked row competes in the SAME FTS result set.
		liveAId = await seedPost(`${TOKEN} canli a`);
		liveBId = await seedPost(`${TOKEN} canli b`);
		sandboxedId = await seedPost(`${TOKEN} karantina`);

		// Stamp the sandbox marker directly. `sandboxed_at` is an epoch-second integer
		// (timestamp mode); any non-null value sandboxes the row — the predicate only
		// tests `sandboxed_at IS NULL`.
		const changed = await h.execD1("UPDATE post_record SET sandboxed_at = ? WHERE id = ?", [
			Math.floor(Date.now() / 1000),
			sandboxedId,
		]);
		expect(changed).toBe(1);
	});

	it("excludes the sandboxed post from an anonymous viewer's results (the core leak)", async () => {
		const ids = (await searchPosts({query: TOKEN})).items.map((e) => e.node.id);
		expect(ids).toContain(liveAId);
		expect(ids).toContain(liveBId);
		expect(ids).not.toContain(sandboxedId);
	});

	it("excludes the sandboxed post from a signed-in non-author member", async () => {
		// The member arm is `sandboxed_at IS NULL OR author_id = :viewerId`; a different
		// member must NOT match the author arm, so they see the live-only set, like anon.
		const ids = (await searchPosts({query: TOKEN}, {cookie: other.cookie})).items.map(
			(e) => e.node.id,
		);
		expect(ids).not.toContain(sandboxedId);
		expect(ids).toContain(liveAId);
		expect(ids).toContain(liveBId);
	});

	it("allocates no count/pagination slot to the sandboxed row (the #1312 vector)", async () => {
		// Only the two live posts are visible to anon, so a first:2 page is the FULL set:
		// `hasNext` must be false. A hydrate-only mask (the bug) would let the sandboxed
		// row occupy a keyset slot under the `LIMIT first+1` fetch (and the `count(*)`),
		// flipping `hasNext` true and/or holing the page — the count/keyset leak this
		// guards. The visible predicate rides count, cursor-rank, and the keyed fetch
		// alike (Search.ts `ftsKeysetKeys`), so the slot proof is the count proof.
		const c = await searchPosts({query: TOKEN, first: 2});
		const ids = c.items.map((e) => e.node.id);
		expect(c.items.length).toBe(2);
		expect(new Set(ids)).toEqual(new Set([liveAId, liveBId]));
		expect(ids).not.toContain(sandboxedId);
		expect(c.pagination.hasNext).toBe(false);
	});

	it("shows the author their own sandboxed post in results", async () => {
		const c = await searchPosts({query: TOKEN}, {cookie: author.cookie});
		const ids = c.items.map((e) => e.node.id);
		expect(ids).toContain(sandboxedId);
		expect(ids).toContain(liveAId);
		expect(ids).toContain(liveBId);
		expect(c.items.length).toBe(3);
	});

	it("shows a moderator the sandboxed post in results", async () => {
		const c = await searchPosts({query: TOKEN}, {cookie: moderator.cookie});
		const ids = c.items.map((e) => e.node.id);
		expect(ids).toContain(sandboxedId);
		expect(c.items.length).toBe(3);
	});
});
