/**
 * fate-operation integration tests (T2, ADR 0040) — site-search resolver on the
 * wire, driven through {@link runFateOp} (idiom per `sozluk-keyset.test.ts`:
 * per-test fresh `node:sqlite` D1 + `WorkerLive` layer).
 *
 * Exercises the real FTS5 path (`node:sqlite` ships FTS5 + bm25): Turkish
 * normalization (diacritic + dotted-`i` folding), prefix matching, bm25-ranked
 * keyset pagination, soft-deleted/non-matching exclusion, and the min-length
 * boundary. Fixtures are seeded via the real Sozluk/Pano write paths so the
 * dual-write FTS sync (ADR 0080) is what populates the search index — the test
 * asserts the end-to-end write→index→search loop, not a hand-seeded FTS table.
 */
import {Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Database} from "../../db/Database";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.testing";
import {layerStub} from "../pasaport/better-auth.testing";
import {makeFateLayer, type WorkerFateServices} from "./layers";
import {runFateOp} from "./run-fate-op";

type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};
interface TermNode {
	slug: string;
	title: string;
}
interface PostNode {
	id: string;
	title: string;
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

/** Seed a term through the real Sozluk write path so the FTS sync runs. */
async function seedTerm(slug: string, title: string): Promise<void> {
	const res = await runFateOp(
		WorkerLive,
		{
			kind: "mutation",
			name: "definition.add",
			input: {termSlug: slug, termTitle: title, body: `${title} gövde`},
			select: ["id"],
		},
		{auth: {id: "u-author", name: "author", email: "a@x.t"}},
	);
	expect(res.result.ok).toBe(true);
}

/** Seed a post through the real Pano write path so the FTS sync runs. Returns its id. */
async function seedPost(title: string): Promise<string> {
	const res = await runFateOp(
		WorkerLive,
		{
			kind: "mutation",
			name: "post.submit",
			input: {title, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{auth: {id: "u-author", name: "author", email: "a@x.t"}},
	);
	expect(res.result.ok).toBe(true);
	if (!res.result.ok) return "";
	return (res.result.data as {id: string}).id;
}

async function searchTerms(args: Record<string, unknown>): Promise<Connection<TermNode>> {
	const res = await runFateOp(WorkerLive, {
		kind: "list",
		name: "searchTerms",
		args,
		select: ["slug", "title"],
	});
	expect(res.result.ok).toBe(true);
	if (!res.result.ok) throw new Error("searchTerms failed");
	return res.result.data as Connection<TermNode>;
}

async function searchPosts(args: Record<string, unknown>): Promise<Connection<PostNode>> {
	const res = await runFateOp(WorkerLive, {
		kind: "list",
		name: "searchPosts",
		args,
		select: ["id", "title"],
	});
	expect(res.result.ok).toBe(true);
	if (!res.result.ok) throw new Error("searchPosts failed");
	return res.result.data as Connection<PostNode>;
}

describe("fate ops — searchTerms (Turkish lexical FTS)", () => {
	beforeEach(async () => {
		await seedTerm("istanbul", "İstanbul");
		await seedTerm("sisli", "Şişli");
		await seedTerm("ankara", "Ankara");
	});

	it("matches Turkish titles diacritic- and dotted-i-insensitively", async () => {
		// "istanbul" (ASCII) matches "İstanbul" (dotted capital I) — the unicode61
		// ASCII-wrong case-fold is sidestepped by the app-side normalized column.
		const c1 = await searchTerms({query: "istanbul"});
		expect(c1.items.map((e) => e.node.slug)).toEqual(["istanbul"]);

		// "sisli" (ASCII) matches "Şişli" (ş/ş diacritics folded to s).
		const c2 = await searchTerms({query: "sisli"});
		expect(c2.items.map((e) => e.node.slug)).toEqual(["sisli"]);
	});

	it("prefix-matches (poor-man's stemmer) and excludes non-matching terms", async () => {
		const c = await searchTerms({query: "ist"});
		expect(c.items.map((e) => e.node.slug)).toEqual(["istanbul"]);
		// "ankara" / "sisli" are not in the result for an "ist" prefix.
		expect(c.items.find((e) => e.node.slug === "ankara")).toBeUndefined();
	});

	it("the cursor round-trips to the next page with no skips/dupes", async () => {
		// Three terms sharing a common prefix token so bm25 ties make the slug-asc
		// tiebreaker the thing ordering the page.
		await seedTerm("proje-a", "ortak proje a");
		await seedTerm("proje-b", "ortak proje b");
		await seedTerm("proje-c", "ortak proje c");

		const p1 = await searchTerms({query: "ortak", first: 2});
		expect(p1.items.length).toBe(2);
		expect(p1.pagination.hasNext).toBe(true);
		const after = p1.pagination.nextCursor;
		expect(after).toBeDefined();

		const p2 = await searchTerms({query: "ortak", first: 2, after});
		const all = [...p1.items, ...p2.items].map((e) => e.node.slug);
		expect(all).toEqual(["proje-a", "proje-b", "proje-c"]);
		expect(new Set(all).size).toBe(3);
		expect(p2.pagination.hasNext).toBe(false);
	});

	it("a below-min-length query returns an empty connection (not everything)", async () => {
		const c = await searchTerms({query: "i"});
		expect(c.items).toEqual([]);
		expect(c.pagination.hasNext).toBe(false);
	});

	it("a non-existent cursor collapses to an empty page", async () => {
		const c = await searchTerms({query: "istanbul", first: 2, after: "does-not-match"});
		expect(c.items).toEqual([]);
		expect(c.pagination.hasNext).toBe(false);
		expect(c.pagination.nextCursor).toBeUndefined();
	});
});

describe("fate ops — searchPosts (FTS + soft-delete exclusion)", () => {
	it("matches post titles and excludes a deleted post", async () => {
		const keepId = await seedPost("Yazılım mimarisi üzerine");
		const dropId = await seedPost("Yazılım testleri hakkında");

		const before = await searchPosts({query: "yazilim"});
		expect(before.items.map((e) => e.node.id).sort()).toEqual([keepId, dropId].sort());

		// Hard-delete one post through the real Pano path; its FTS row must drop.
		const del = await runFateOp(
			WorkerLive,
			{kind: "mutation", name: "post.delete", input: {id: dropId}, select: ["id"]},
			{auth: {id: "u-author", name: "author", email: "a@x.t"}},
		);
		expect(del.result.ok).toBe(true);

		const after = await searchPosts({query: "yazilim"});
		expect(after.items.map((e) => e.node.id)).toEqual([keepId]);
	});

	it("a retitled post is re-indexed under its new title", async () => {
		const id = await seedPost("Eski başlık");
		const before = await searchPosts({query: "eski"});
		expect(before.items.map((e) => e.node.id)).toEqual([id]);

		const edit = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, title: "Yeni başlık"},
				select: ["id"],
			},
			{auth: {id: "u-author", name: "author", email: "a@x.t"}},
		);
		expect(edit.result.ok).toBe(true);

		const stale = await searchPosts({query: "eski"});
		expect(stale.items).toEqual([]);
		const fresh = await searchPosts({query: "yeni"});
		expect(fresh.items.map((e) => e.node.id)).toEqual([id]);
	});

	it("excludes a soft-deleted definition's term from a body match it never indexes (title-only scope)", async () => {
		// Scope v1 is titles only: a term whose title doesn't contain the query is
		// not returned even if its definition body does — guards against scope creep.
		await seedTerm("kavram", "Kavram");
		const c = await searchTerms({query: "govde"}); // "gövde" only appears in the body
		expect(c.items).toEqual([]);
	});
});
