/**
 * pano feed viewer state (`posts` list stamps `myVote`/`isSaved`) — black-box
 * against the deployed worker `/fate` route (ADR 0026–0031, ADR 0082).
 *
 * Drives #695: the main `posts` feed must reflect the signed-in viewer's own
 * vote/save state the same way the post-detail `post` query and `savedPosts`
 * already do — the resolver re-hydrates the keyset page through
 * `Pano.getPostsByIds(ids, {viewerId})` so `myVote`/`isSaved` ride one batch.
 * Everything is observed over HTTP: posts are seeded + voted + saved via `/fate`
 * mutations, then the feed is read back per viewer. Anonymous reads must stay
 * neutral (`null` state).
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027): its one D1 is
 * shared with every migrated file. It isolates by NS — every email/title/host it seeds
 * carries the deterministic `${NS}-…` prefix, and the feed read is HOST-scoped to this
 * file's own `${NS}.example.com` host, so the `posts(host)` query returns exactly this
 * file's seeded set and never another file's rows on the shared D1.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

interface PostNode {
	__typename: string;
	id: string;
	title: string;
	myVote: number | null;
	isSaved: boolean | null;
}

type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

const FEED_HOST = `${NS}.example.com`;

let viewer: {userId: string; cookie: string};
let other: {userId: string; cookie: string};

/** A post the viewer votes + saves. */
let votedSaved = "";
/** A post the viewer only votes. */
let votedOnly = "";
/** A post the viewer only saves. */
let savedOnly = "";
/** A post the viewer neither votes nor saves. */
let neutral = "";

/** Submit a post under the viewer cookie on the shared feed host; return its id. */
async function seedPost(title: string): Promise<string> {
	const r = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title, url: `https://${FEED_HOST}/${title}`, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: viewer.cookie},
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("seedPost failed");
	return (r.data as PostNode).id;
}

/** Read the host-scoped feed for a cookie (anonymous when omitted), as an id→node map. */
async function feed(cookie?: string): Promise<Map<string, PostNode>> {
	const r = await h.fate(
		{
			kind: "list",
			name: "posts",
			args: {sort: "new", host: FEED_HOST, first: 50},
			select: ["id", "title", "myVote", "isSaved"],
		},
		cookie ? {cookie} : undefined,
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("feed read failed");
	return new Map((r.data as Connection<PostNode>).items.map((e) => [e.node.id, e.node]));
}

beforeAll(async () => {
	viewer = await h.signUp(`${NS}-viewer@test.local`, "hunter2hunter2", "izleyen");
	other = await h.signUp(`${NS}-other@test.local`, "hunter2hunter2", "öteki");

	votedSaved = await seedPost(`${NS}-voted-saved`);
	votedOnly = await seedPost(`${NS}-voted-only`);
	savedOnly = await seedPost(`${NS}-saved-only`);
	neutral = await seedPost(`${NS}-neutral`);

	for (const id of [votedSaved, votedOnly]) {
		const r = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id}, select: ["id"]},
			{cookie: viewer.cookie},
		);
		expect(r.ok).toBe(true);
	}
	for (const id of [votedSaved, savedOnly]) {
		const r = await h.fate(
			{kind: "mutation", name: "post.save", input: {id}, select: ["id"]},
			{cookie: viewer.cookie},
		);
		expect(r.ok).toBe(true);
	}
});

describe("pano feed — viewer state stamping (#695)", () => {
	it("stamps the signed-in viewer's myVote + isSaved per feed row", async () => {
		const rows = await feed(viewer.cookie);

		expect(rows.get(votedSaved)).toMatchObject({myVote: 1, isSaved: true});
		expect(rows.get(votedOnly)).toMatchObject({myVote: 1, isSaved: false});
		expect(rows.get(savedOnly)).toMatchObject({myVote: null, isSaved: true});
		expect(rows.get(neutral)).toMatchObject({myVote: null, isSaved: false});
	});

	it("leaves feed rows neutral for a signed-out viewer", async () => {
		const rows = await feed();

		for (const id of [votedSaved, votedOnly, savedOnly, neutral]) {
			expect(rows.get(id)).toMatchObject({myVote: null, isSaved: null});
		}
	});

	it("scopes the stamp to the reading viewer (no cross-talk)", async () => {
		// `other` voted/saved nothing here, so every row is neutral for them — the
		// stamp follows the cookie, not the post.
		const rows = await feed(other.cookie);

		for (const id of [votedSaved, votedOnly, savedOnly, neutral]) {
			expect(rows.get(id)).toMatchObject({myVote: null, isSaved: false});
		}
	});
});
