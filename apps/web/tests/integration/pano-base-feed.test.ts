/**
 * pano base feed / viewer overlay split (#2322, epic #2316 leg B) — black-box against
 * the deployed worker (ADR 0026–0031, ADR 0082).
 *
 * Proves the leg-B server split:
 *   1. The `GET /fate/pano/feed` base feed is served with `sort`/`host`/pagination in
 *      the URL, carries NO viewer-scoped field, and is BYTE-IDENTICAL for an anonymous
 *      request and a signed-in one — the whole point of a viewer-invariant, cacheable
 *      base. An anon GET succeeds with no session (and the response sets no cookie), so
 *      it does no session validation.
 *   2. The base feed and the per-viewer `posts` feed on `POST /fate` are separate
 *      surfaces: the `posts` feed still stamps the signed-in viewer's `myVote`/`isSaved`
 *      (the split changed nothing there).
 *
 * The base feed serves unconditionally — its leg-B dark-ship flag graduated to on@100%
 * and was retired (ADR 0136), so the split is now the source of truth.
 *
 * Shared-stage NS isolation (ADR 0104): every seeded title/host carries the `${NS}-`
 * prefix and the base feed is HOST-scoped to this file's `${NS}.example.com`, so the read
 * returns exactly this file's seeded set on the shared D1.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);
const FEED_HOST = `${NS}.example.com`;

interface BaseNode {
	__typename: string;
	id: string;
	title: string;
	myVote?: unknown;
	isSaved?: unknown;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

let author: {userId: string; cookie: string};
let viewer: {userId: string; cookie: string};
const seeded: string[] = [];

async function seedPost(title: string): Promise<string> {
	const r = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title, url: `https://${FEED_HOST}/${title}`, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("seedPost failed");
	return (r.data as {id: string}).id;
}

/** GET the base feed over the URL surface; returns the raw Response (caller asserts). */
function getBaseFeed(query: string, cookie?: string): Promise<Response> {
	return h.req(`/fate/pano/feed?${query}`, cookie ? {headers: {cookie}} : undefined);
}

beforeAll(async () => {
	author = await h.signUp(`${NS}-author@test.local`, "hunter2hunter2", "yazar");
	viewer = await h.signUp(`${NS}-viewer@test.local`, "hunter2hunter2", "izleyen");
	// A fresh account is a çaylak; promote so the author's posts are live (not sandboxed)
	// and the viewer can cast a real vote (#1810 earn-to-vote gate).
	await h.promoteToYazar(author.userId);
	await h.promoteToYazar(viewer.userId);

	for (const n of ["alpha", "bravo", "charlie"]) {
		seeded.push(await seedPost(`${NS}-${n}`));
	}
});

describe("pano base feed — GET surface + viewer-invariant base (#2322)", () => {
	it("serves the base feed over GET with sort/host in the URL, no viewer-scoped field", async () => {
		const res = await getBaseFeed(`sort=new&host=${FEED_HOST}&first=50`);
		expect(res.status).toBe(200);
		const conn = (await res.json()) as Connection<BaseNode>;
		const titles = conn.items.map((e) => e.node.title).sort();
		expect(titles).toEqual([`${NS}-alpha`, `${NS}-bravo`, `${NS}-charlie`]);
		// The base carries NO viewer-scoped field.
		for (const {node} of conn.items) {
			expect(Object.hasOwn(node, "myVote")).toBe(false);
			expect(Object.hasOwn(node, "isSaved")).toBe(false);
		}
	});

	it("paginates via the URL cursor (first + nextCursor)", async () => {
		const first = await getBaseFeed(`sort=new&host=${FEED_HOST}&first=2`);
		expect(first.status).toBe(200);
		const page1 = (await first.json()) as Connection<BaseNode>;
		expect(page1.items).toHaveLength(2);
		expect(page1.pagination.hasNext).toBe(true);
		const cursor = page1.pagination.nextCursor;
		expect(cursor, "first page must expose a nextCursor").toBeTruthy();

		const second = await getBaseFeed(
			`sort=new&host=${FEED_HOST}&first=2&after=${encodeURIComponent(cursor!)}`,
		);
		expect(second.status).toBe(200);
		const page2 = (await second.json()) as Connection<BaseNode>;
		// The three seeded posts split 2 + 1 across the cursor with no overlap.
		expect(page2.items).toHaveLength(1);
		const ids1 = page1.items.map((e) => e.node.id);
		expect(ids1).not.toContain(page2.items[0]!.node.id);
	});

	it("is byte-identical for an anonymous request and a signed-in one, and sets no cookie", async () => {
		const query = `sort=new&host=${FEED_HOST}&first=50`;
		const anon = await getBaseFeed(query);
		const authed = await getBaseFeed(query, viewer.cookie);
		expect(anon.status).toBe(200);
		expect(authed.status).toBe(200);
		// No session validation: the base sets no cookie for either caller.
		expect(anon.headers.get("set-cookie")).toBeNull();
		expect(authed.headers.get("set-cookie")).toBeNull();
		// Byte-identical bodies — the base is viewer-invariant by construction.
		expect(await anon.text()).toBe(await authed.text());
	});
});

describe("pano base feed — the per-viewer posts feed is a separate surface (#2322)", () => {
	it("leaves the existing POST /fate posts feed stamping myVote", async () => {
		// Vote a seeded post as the viewer, then read the per-viewer `posts` feed on
		// `POST /fate`: the split left that stamp untouched — myVote rides as before. (The
		// author never self-votes; the viewer votes the author's post.)
		const target = seeded[0]!;
		const voted = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id: target}, select: ["id"]},
			{cookie: viewer.cookie},
		);
		expect(voted.ok).toBe(true);

		const feed = await h.fate(
			{
				kind: "list",
				name: "posts",
				args: {sort: "new", host: FEED_HOST, first: 50},
				select: ["id", "myVote", "isSaved"],
			},
			{cookie: viewer.cookie},
		);
		expect(feed.ok).toBe(true);
		if (!feed.ok) throw new Error("posts feed read failed");
		const rows = new Map(
			(
				feed.data as Connection<{id: string; myVote: boolean | null; isSaved: boolean | null}>
			).items.map((e) => [e.node.id, e.node]),
		);
		expect(rows.get(target)).toMatchObject({myVote: true});
	});
});

describe("pano base feed — edge-cache headers (#2324, ADR 0170)", () => {
	it("stamps Cache-Control + Cache-Tag: pano-feed on the served base feed", async () => {
		const res = await getBaseFeed(`sort=new&host=${FEED_HOST}&first=50`);
		expect(res.status).toBe(200);
		// The TTL backstop + the purge tag the fanned-mutation seam targets (AC#1).
		expect(res.headers.get("cache-control")).toContain("s-maxage=");
		expect(res.headers.get("cache-tag")).toBe("pano-feed");
	});
});
