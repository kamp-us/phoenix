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
 *   2. With the leg-B flag OFF (the default), the GET route 404s — the surface ships
 *      dark. The existing per-viewer `posts` feed on `POST /fate` still stamps the
 *      signed-in viewer's `myVote`/`isSaved` (the split changed nothing there).
 *
 * The base feed is dark behind `pano-base-feed` (default-off). Integration deploys run
 * `ENVIRONMENT=development` (`_integration.ts` → `ensureIntegrationEnv`), so the dev-only
 * override wrapper (`FlagsDevOverrideLive`, #622) is installed — this test flips the flag
 * on for a single request by sending the `phoenix_flag_overrides` cookie. The default-off
 * gate is the shipped state; the cookie only unlocks the flag-ON path for this test.
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

// The dev-override cookie that forces `pano-base-feed` on for a single request (#622 —
// `phoenix_flag_overrides`, a URL-encoded JSON `{key: boolean}` map). Only takes effect
// because integration deploys run with `ENVIRONMENT=development`.
const BASE_FEED_ON_COOKIE = `phoenix_flag_overrides=${encodeURIComponent(
	JSON.stringify({"pano-base-feed": true}),
)}`;

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
		const res = await getBaseFeed(`sort=new&host=${FEED_HOST}&first=50`, BASE_FEED_ON_COOKIE);
		// Name the flag in the failure so an ineffective override fails HERE with a clear
		// cause, not as a confusing shape mismatch downstream.
		expect(
			res.status,
			`GET base feed expected 200 with the flag ON, got ${res.status} — pano-base-feed override did not take effect`,
		).toBe(200);
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
		const first = await getBaseFeed(`sort=new&host=${FEED_HOST}&first=2`, BASE_FEED_ON_COOKIE);
		expect(first.status).toBe(200);
		const page1 = (await first.json()) as Connection<BaseNode>;
		expect(page1.items).toHaveLength(2);
		expect(page1.pagination.hasNext).toBe(true);
		const cursor = page1.pagination.nextCursor;
		expect(cursor, "first page must expose a nextCursor").toBeTruthy();

		const second = await getBaseFeed(
			`sort=new&host=${FEED_HOST}&first=2&after=${encodeURIComponent(cursor!)}`,
			BASE_FEED_ON_COOKIE,
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
		const anon = await getBaseFeed(query, BASE_FEED_ON_COOKIE);
		const authed = await getBaseFeed(query, `${viewer.cookie}; ${BASE_FEED_ON_COOKIE}`);
		expect(anon.status).toBe(200);
		expect(authed.status).toBe(200);
		// No session validation: the base sets no cookie for either caller.
		expect(anon.headers.get("set-cookie")).toBeNull();
		expect(authed.headers.get("set-cookie")).toBeNull();
		// Byte-identical bodies — the base is viewer-invariant by construction.
		expect(await anon.text()).toBe(await authed.text());
	});
});

describe("pano base feed — dark behind the leg-B flag (#2322)", () => {
	it("404s the GET route when the flag is off (default dark state)", async () => {
		const res = await getBaseFeed(`sort=new&host=${FEED_HOST}`);
		expect(res.status).toBe(404);
	});

	it("leaves the existing POST /fate posts feed unchanged (still stamps myVote when off)", async () => {
		// Vote a seeded post as the viewer, then read the existing `posts` feed WITHOUT any
		// flag override: the per-viewer stamp is untouched by the split — myVote rides as
		// before. (The author never self-votes; the viewer votes the author's post.)
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
