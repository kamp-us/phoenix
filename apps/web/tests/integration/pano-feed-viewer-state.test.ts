/**
 * pano feed viewer state (`posts` list stamps `myVote`/`isSaved`) — black-box
 * against the deployed worker `/fate` route (ADR 0026–0031, ADR 0082).
 *
 * Drives #695: the main `posts` feed must reflect the signed-in viewer's own vote/save
 * state the way the post-detail `post` query and `savedPosts` already do.
 *
 * On the run-scoped SHARED stage (ADR 0104 step 7, #1027), so isolation is by NS: every
 * email/title/host carries the `${NS}-…` prefix and the feed read is HOST-scoped to this
 * file's own `${NS}.example.com`, so `posts(host)` never returns another file's rows.
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
	myVote: boolean | null;
	isSaved: boolean | null;
}

type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

const FEED_HOST = `${NS}.example.com`;

let viewer: {userId: string; cookie: string};
let other: {userId: string; cookie: string};

let votedSaved = "";
let votedOnly = "";
let savedOnly = "";
let neutral = "";

// Posts are authored by `other`, not the `viewer`: since #2216 blocks self-voting, the
// viewer's fixture votes below have to land on content it did not write.
async function seedPost(title: string): Promise<string> {
	const r = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title, url: `https://${FEED_HOST}/${title}`, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: other.cookie},
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("seedPost failed");
	return (r.data as PostNode).id;
}

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
	// Since #1810's "earn to vote" gate a fresh çaylak is rejected at cast, so promote the
	// voter; promote `other` too, or its posts stay sandboxed and never reach the feed.
	await h.promoteToYazar(viewer.userId);
	await h.promoteToYazar(other.userId);

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

		expect(rows.get(votedSaved)).toMatchObject({myVote: true, isSaved: true});
		expect(rows.get(votedOnly)).toMatchObject({myVote: true, isSaved: false});
		expect(rows.get(savedOnly)).toMatchObject({myVote: false, isSaved: true});
		expect(rows.get(neutral)).toMatchObject({myVote: false, isSaved: false});
	});

	it("leaves feed rows neutral for a signed-out viewer", async () => {
		const rows = await feed();

		for (const id of [votedSaved, votedOnly, savedOnly, neutral]) {
			expect(rows.get(id)).toMatchObject({myVote: null, isSaved: null});
		}
	});

	it("scopes the stamp to the reading viewer (no cross-talk)", async () => {
		const rows = await feed(other.cookie);

		for (const id of [votedSaved, votedOnly, savedOnly, neutral]) {
			expect(rows.get(id)).toMatchObject({myVote: false, isSaved: false});
		}
	});
});
