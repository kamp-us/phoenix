/**
 * pano reads — black-box against the deployed worker `/fate` route (ADR 0026–0031).
 *
 * Ports the read surface of three pre-alchemy suites that drove the `Pano`
 * Effect service / `/fate` route directly inside workerd:
 *   - `fate-pano-read.test.ts` — `posts(sort, host)`, `post(idOrSlug)` detail +
 *     tags, the `Post.comments` keyset, and the `Comment` scalar surface over
 *     `/fate`.
 *   - `pano-post.test.ts` — submit a post and read it back (detail + feed); unknown
 *     id → null; host filter narrows to the requested host.
 *   - `pano-post-connection.test.ts` — `posts` connection paging (every row once,
 *     `new` ordering, ghost cursor).
 *
 * Everything is observed over HTTP: there is no admin route to inject pano data,
 * so posts + comments are seeded via `/fate` mutations under a signed-up cookie
 * (`post.submit`, `comment.add`). The author of a seeded post/comment is the
 * signed-up user's name. Distinct comment authors come from distinct sign-ups.
 *
 * The connection envelope has NO `totalCount` (`{items:[{cursor,node}],
 * pagination:{hasNext, hasPrevious:false, nextCursor?}}`), so the old `totalCount`
 * assertions are dropped and "every row once" is re-expressed by walking
 * `nextCursor` and asserting the union of node ids has the expected size, no dupes.
 * D1 row-shape assertions (post_record / comment_record columns, body_excerpt,
 * the (author_id, created_at) index probe) are not black-box and are dropped;
 * behavior is re-expressed by re-resolving entities over `/fate`.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one D1 is
 * shared across every migrated file: every host/email is prefixed with `NS` (this file's
 * deterministic `nsToken`). The ordered-feed assertions are scoped by HOST — each seeds its
 * posts under a per-test `${NS}-…` host so the `posts(host)` query filters to exactly this
 * file's (and this test's) rows. The host-scoping IS the namespace: no ordered assertion
 * reads a feed unfiltered by an NS-host.
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
	url: string | null;
	host: string | null;
	score: number;
	commentCount: number;
	author: string;
	authorId: string;
	myVote: boolean | null;
	tags: Array<{kind: string; label: string}>;
}
interface CommentNode {
	__typename: string;
	id: string;
	body: string;
	author: string;
	authorId: string;
	score: number;
	myVote: boolean | null;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

const POST_SELECT = ["id", "title", "url", "host", "score", "commentCount", "author", "tags"];

let author: {userId: string; cookie: string};
// Five distinct comment authors so the comment scalar surface (author/authorId)
// is observable per row.
const commenters: Array<{userId: string; cookie: string}> = [];

// The single seeded read fixture: one post under a unique host, with five
// chronological comments. The comment ids are forge ULIDs (monotonic with
// creation order), so the keyset `(created_at asc, id asc)` order equals
// insertion order.
const READ_HOST = `${NS}.example.com`;
let postId = "";
const commentIds: string[] = [];

beforeAll(async () => {
	author = await h.signUp(`${NS}-author@test.local`, "hunter2hunter2", "anka");
	for (let i = 0; i < 5; i++) {
		commenters.push(await h.signUp(`${NS}-c${i}@test.local`, "hunter2hunter2", `commenter ${i}`));
	}

	const submitted = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {
				title: "Fate Pano Read",
				url: `https://${READ_HOST}/fate-read`,
				body: "fate pano read body",
				tags: [{kind: "tartışma"}, {kind: "soru"}],
			},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	expect(submitted.ok).toBe(true);
	if (!submitted.ok) throw new Error("seed post.submit failed");
	postId = (submitted.data as PostNode).id;

	// Five chronological comments, each from a distinct author. comment.add
	// returns the re-resolved Comment carrying its id.
	for (let i = 0; i < 5; i++) {
		const added = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: `comment ${i} body — long enough`},
				select: ["id"],
			},
			{cookie: commenters[i]!.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) throw new Error("seed comment.add failed");
		commentIds.push((added.data as CommentNode).id);
	}
});

describe("pano reads — /fate", () => {
	it("posts(hot) returns rows with id cursors", async () => {
		const result = await h.fate({
			kind: "list",
			name: "posts",
			args: {sort: "hot"},
			select: ["id", "title", "score", "commentCount", "author"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as Connection<PostNode>;
		const seeded = data.items.find((e) => e.node.id === postId);
		expect(seeded).toBeDefined();
		expect(seeded!.cursor).toBe(postId); // cursor is the post id keyset
		expect(seeded!.node.title).toBe("Fate Pano Read");
		expect(seeded!.node.commentCount).toBe(5);
		expect(seeded!.node.author).toBe("anka");
		expect(data.pagination.hasPrevious).toBe(false);
	});

	it("posts(host) filters by host", async () => {
		const result = await h.fate({
			kind: "list",
			name: "posts",
			args: {sort: "new", host: READ_HOST},
			select: ["id", "host"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as Connection<PostNode>;
		expect(data.items.length).toBeGreaterThan(0);
		expect(data.items.every((e) => e.node.host === READ_HOST)).toBe(true);
		expect(data.items.some((e) => e.node.id === postId)).toBe(true);
	});

	it("post(idOrSlug) returns the detail row with tags", async () => {
		const result = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId},
			// `tags` is a scalar embedded array (`{kind, label}[]`), selected as a
			// whole field (no `tags.kind`/`tags.label` relation paths).
			select: ["id", "title", "url", "host", "score", "commentCount", "tags"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as PostNode;
		expect(data.id).toBe(postId);
		expect(data.title).toBe("Fate Pano Read");
		expect(data.host).toBe(READ_HOST);
		expect(data.url).toBe(`https://${READ_HOST}/fate-read`);
		expect(data.commentCount).toBe(5);
		expect(data.tags.map((t) => t.kind).sort()).toEqual(["soru", "tartışma"]);
	});

	it("post(idOrSlug) returns null for an unknown id", async () => {
		const result = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: "post_does_not_exist"},
			select: ["id"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("Post.comments paginates by DB keyset with no skips/dupes across pages", async () => {
		// Page 1: first 2 in chronological-asc order.
		const page1 = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2}},
			select: ["id", "comments.id", "comments.body", "comments.author"],
		});
		expect(page1.ok).toBe(true);
		if (!page1.ok) return;
		const d1 = page1.data as {comments: Connection<CommentNode>};
		expect(d1.comments.items.map((e) => e.node.id)).toEqual(commentIds.slice(0, 2));
		expect(d1.comments.pagination.hasNext).toBe(true);
		const cursor = d1.comments.pagination.nextCursor;
		expect(cursor).toBe(commentIds[1]); // cursor is the last node id

		// Page 2: after the page-1 cursor.
		const page2 = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2, after: cursor}},
			select: ["id", "comments.id"],
		});
		expect(page2.ok).toBe(true);
		if (!page2.ok) return;
		const d2 = page2.data as {comments: Connection<CommentNode>};
		expect(d2.comments.items.map((e) => e.node.id)).toEqual(commentIds.slice(2, 4));
		expect(d2.comments.pagination.hasNext).toBe(true);

		// Page 3: the last comment, no more.
		const page3 = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2, after: d2.comments.pagination.nextCursor}},
			select: ["id", "comments.id"],
		});
		expect(page3.ok).toBe(true);
		if (!page3.ok) return;
		const d3 = page3.data as {comments: Connection<CommentNode>};
		expect(d3.comments.items.map((e) => e.node.id)).toEqual([commentIds[4]]);
		expect(d3.comments.pagination.hasNext).toBe(false);

		// No skips/dupes: the union of all page ids is exactly the 5 seeded.
		const allIds = [
			...d1.comments.items.map((e) => e.node.id),
			...d2.comments.items.map((e) => e.node.id),
			...d3.comments.items.map((e) => e.node.id),
		];
		expect(new Set(allIds).size).toBe(5);
		expect([...allIds].sort()).toEqual([...commentIds].sort());
	});

	it("Comment nodes carry the scalar surface (author/authorId/score/myVote)", async () => {
		const result = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 1}},
			select: [
				"comments.id",
				"comments.body",
				"comments.author",
				"comments.authorId",
				"comments.score",
				"comments.myVote",
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const node = (result.data as {comments: Connection<CommentNode>}).comments.items[0]!.node;
		expect(node.author).toBe("commenter 0");
		expect(node.authorId).toBe(commenters[0]!.userId);
		expect(node.score).toBe(0);
		// Anonymous viewer → myVote null (no cookie on this read).
		expect(node.myVote).toBeNull();
	});

	it("submits a post and reads it back via post(id) and via the posts feed", async () => {
		const host = `${NS}-readback.example.com`;
		const submitted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: "phoenix nasıl tek worker'da çalışıyor",
					url: `https://${host}/phoenix`,
					body: "Tek deploy, tek bind, tek SPA.",
					tags: [{kind: "göster"}],
				},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		const id = (submitted.data as PostNode).id;
		expect(id).toMatch(/^post_/);

		const detail = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: id},
			select: POST_SELECT,
		});
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		const post = detail.data as PostNode;
		expect(post.id).toBe(id);
		expect(post.title).toContain("phoenix");
		expect(post.url).toBe(`https://${host}/phoenix`);
		expect(post.host).toBe(host);
		expect(post.author).toBe("anka");
		expect(post.score).toBe(0);
		expect(post.commentCount).toBe(0);
		expect(post.tags).toHaveLength(1);
		expect(post.tags[0]!.kind).toBe("göster");

		// Read it back through the feed (filtered to its own host so the row is found).
		const feed = await h.fate({
			kind: "list",
			name: "posts",
			args: {sort: "new", host, first: 50},
			select: ["id", "title", "url", "host", "score", "tags"],
		});
		expect(feed.ok).toBe(true);
		if (!feed.ok) return;
		const summary = (feed.data as Connection<PostNode>).items.find((e) => e.node.id === id);
		expect(summary).toBeDefined();
		expect(summary!.node.title).toContain("phoenix");
		expect(summary!.node.url).toBe(`https://${host}/phoenix`);
		expect(summary!.node.host).toBe(host);
		expect(summary!.node.score).toBe(0);
		expect(summary!.node.tags).toHaveLength(1);
		expect(summary!.node.tags[0]!.kind).toBe("göster");
	});

	it("host filter narrows to the requested host", async () => {
		const tag = `${NS}-${Math.random().toString(36).slice(2, 8)}`;
		const hostA = `${tag}-a.example.com`;
		const hostB = `${tag}-b.example.com`;

		const a = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "host a post", url: `https://${hostA}/x`, tags: [{kind: "meta"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		const b = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "host b post", url: `https://${hostB}/x`, tags: [{kind: "meta"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		const aId = (a.data as PostNode).id;
		const bId = (b.data as PostNode).id;

		const filtered = await h.fate({
			kind: "list",
			name: "posts",
			args: {host: hostA, first: 50},
			select: ["id"],
		});
		expect(filtered.ok).toBe(true);
		if (!filtered.ok) return;
		const ids = (filtered.data as Connection<PostNode>).items.map((e) => e.node.id);
		expect(ids).toContain(aId);
		expect(ids).not.toContain(bId);
	});
});

describe("posts connection — keyset walk", () => {
	it("paginates through every row exactly once when walking nextCursor", async () => {
		const host = `${NS}-paginate.example.com`;
		const seededIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = await h.fate(
				{
					kind: "mutation",
					name: "post.submit",
					input: {title: `title ${i}`, url: `https://${host}/p/${i}`, tags: [{kind: "tartışma"}]},
					select: ["id"],
				},
				{cookie: author.cookie},
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			seededIds.push((r.data as PostNode).id);
			// created_at is second-resolution; force a gap so `sort:new` ordering is
			// deterministic across the five rows.
			if (i < 4) await new Promise((res) => setTimeout(res, 1100));
		}

		const collected: string[] = [];
		let after: string | undefined;
		let pages = 0;
		// Walk the host-scoped connection two at a time until exhausted.
		for (;;) {
			const page = await h.fate({
				kind: "list",
				name: "posts",
				args: {sort: "new", first: 2, host, ...(after ? {after} : {})},
				select: ["id"],
			});
			expect(page.ok).toBe(true);
			if (!page.ok) return;
			const conn = page.data as Connection<PostNode>;
			const ids = conn.items.map((e) => e.node.id);
			// Each non-empty page's last cursor is the last node id.
			if (ids.length > 0) {
				expect(conn.items[ids.length - 1]!.cursor).toBe(ids[ids.length - 1]);
			}
			collected.push(...ids);
			pages++;
			if (!conn.pagination.hasNext) break;
			after = conn.pagination.nextCursor;
			if (pages > 10) throw new Error("connection walk did not terminate");
		}

		// Every seeded row appears exactly once, no dupes.
		expect(new Set(collected).size).toBe(5);
		expect([...collected].sort()).toEqual([...seededIds].sort());
		// `sort:new` returns newest-first, i.e. reverse insertion order.
		expect(collected).toEqual([...seededIds].reverse());
	});

	it("a ghost cursor (a since-deleted / never-existed post) yields no rows", async () => {
		const host = `${NS}-ghost.example.com`;
		const r = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "the only one", url: `https://${host}/x`, tags: [{kind: "meta"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(r.ok).toBe(true);

		const page = await h.fate({
			kind: "list",
			name: "posts",
			args: {first: 10, host, after: "post_DOES_NOT_EXIST"},
			select: ["id"],
		});
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		const conn = page.data as Connection<PostNode>;
		expect(conn.items).toHaveLength(0);
		expect(conn.pagination.hasNext).toBe(false);
	});
});

// not portable black-box: pano-post-connection.test.ts `totalCount` assertions —
// the connection envelope has no `totalCount`; "every row once" is re-expressed
// above by walking `nextCursor` and asserting the union of ids (size 5, no dupes).
// not portable black-box: pano-submit-post.test.ts D1 row-shape assertions
// (post_record columns, body_excerpt, tags CSV) and the (author_id, created_at)
// index probe — re-expressed by re-resolving the Post over `/fate`.
