/**
 * pano comment lifecycle DEPTH — black-box against the deployed worker `/fate`
 * route (ADR 0026–0031).
 *
 * Ports the depth surface of the pre-alchemy comment suites that drove the
 * `Pano` Effect service directly inside workerd:
 *   - `pano-edit-delete-comment.test.ts` — comment ownership (non-author
 *     edit/delete → UNAUTHORIZED), unknown-id codes, leaf-delete removal,
 *     parent-with-replies soft-delete (`[silindi]` placeholder), idempotent
 *     re-delete.
 *   - `pano-vote-comment.test.ts` — comment vote idempotency, round-trip,
 *     retract-on-never-voted no-op.
 *   - `pano-comments-connection.test.ts` — reply-aware comment feed (leaf
 *     deleted is gone, parent-with-replies stays as a tombstone), stale/ghost
 *     cursor edges, the `after`-row-removed-between-pages edge.
 *   - nested-reply/placeholder bits of `pano-add-comment.test.ts`.
 *
 * Everything is observed over HTTP. Author identity comes from the session
 * (`h.signUp`), so an ownership test signs up an author + an intruder, and a
 * vote-from-another-user test uses a second cookie. The old service-return
 * flags (`{deleted, hasReplies, placeholder}`, `changed`) are NOT on the wire;
 * behavior is re-expressed via the re-resolved entity + the comments feed +
 * `post(id).commentCount` over `/fate`. The connection envelope has NO
 * `totalCount`, so the old `totalCount` assertions are dropped and re-expressed
 * via the id-union of the comments feed.
 *
 * D1 is shared across all test files (one deploy), so every title/email is
 * uniquely prefixed (`panocomm-${Date.now()}-…`).
 */
import {beforeAll, describe, expect, it} from "vitest";
import {harness} from "./_harness.ts";

const h = harness();

const STAMP = Date.now();

interface PostNode {
	__typename: string;
	id: string;
	title: string;
	commentCount: number;
	myVote: number | null;
}
interface CommentNode {
	__typename: string;
	id: string;
	parentId: string | null;
	body: string;
	author: string;
	authorId: string;
	score: number;
	myVote: number | null;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

let author: {userId: string; cookie: string};
let intruder: {userId: string; cookie: string};
let voter: {userId: string; cookie: string};

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
	if (!r.ok) throw new Error("seedPost failed");
	return (r.data as PostNode).id;
}

/** Add a comment under a cookie (default author); assert success; return its id. */
async function seedComment(
	postId: string,
	body: string,
	opts: {cookie?: string; parentId?: string} = {},
): Promise<string> {
	const r = await h.fate(
		{
			kind: "mutation",
			name: "comment.add",
			input: {postId, body, ...(opts.parentId ? {parentId: opts.parentId} : {})},
			select: ["id"],
		},
		{cookie: opts.cookie ?? author.cookie},
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("seedComment failed");
	return (r.data as CommentNode).id;
}

/** Read the comments feed for a post (large page); return the comment nodes. */
async function readComments(postId: string): Promise<CommentNode[]> {
	const r = await h.fate({
		kind: "query",
		name: "post",
		args: {idOrSlug: postId, comments: {first: 200}},
		select: ["id", "comments.id", "comments.body", "comments.authorId", "comments.parentId"],
	});
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("readComments failed");
	return (r.data as {comments: Connection<CommentNode>}).comments.items.map((e) => e.node);
}

/** Re-resolve a post's commentCount over `/fate`. */
async function commentCount(postId: string): Promise<number> {
	const r = await h.fate({
		kind: "query",
		name: "post",
		args: {idOrSlug: postId},
		select: ["id", "commentCount"],
	});
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("commentCount read failed");
	return (r.data as PostNode).commentCount;
}

beforeAll(async () => {
	author = await h.signUp(`panocomm-${STAMP}-author@test.local`, "hunter2hunter2", "yazar");
	intruder = await h.signUp(`panocomm-${STAMP}-intruder@test.local`, "hunter2hunter2", "davetsiz");
	voter = await h.signUp(`panocomm-${STAMP}-voter@test.local`, "hunter2hunter2", "oycu");
});

describe("pano comments — ownership (edit/delete)", () => {
	it("a non-author edit is rejected with UNAUTHORIZED; the body is unchanged", async () => {
		const postId = await seedPost(`panocomm-${STAMP} owned-comment target`);
		const id = await seedComment(postId, "the original comment body");

		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.edit",
				input: {id, body: "intruder should not write this"},
				select: ["id"],
			},
			{cookie: intruder.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");

		// The body survives: re-resolve it via the comments feed.
		const comments = await readComments(postId);
		const row = comments.find((c) => c.id === id);
		expect(row).toBeDefined();
		expect(row!.body).toBe("the original comment body");
	});

	it("a non-author delete is rejected with UNAUTHORIZED; the comment survives", async () => {
		const postId = await seedPost(`panocomm-${STAMP} defended-comment target`);
		const id = await seedComment(postId, "this comment is defended");

		const result = await h.fate(
			{kind: "mutation", name: "comment.delete", input: {id}, select: ["id"]},
			{cookie: intruder.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");

		// Still present + count unchanged.
		expect(await commentCount(postId)).toBe(1);
		const comments = await readComments(postId);
		expect(comments.some((c) => c.id === id)).toBe(true);
	});

	it("editing an unknown comment id surfaces COMMENT_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.edit",
				input: {id: `comm_${STAMP}_does_not_exist`, body: "x"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("COMMENT_NOT_FOUND");
	});

	it("deleting an unknown comment id surfaces COMMENT_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.delete",
				input: {id: `comm_${STAMP}_does_not_exist`},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("COMMENT_NOT_FOUND");
	});

	it("editing with an empty body surfaces BODY_REQUIRED; over 5000 chars BODY_TOO_LONG", async () => {
		const postId = await seedPost(`panocomm-${STAMP} edit-validation target`);
		const id = await seedComment(postId, "valid original body");

		const empty = await h.fate(
			{kind: "mutation", name: "comment.edit", input: {id, body: "    "}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(empty.ok).toBe(false);
		if (empty.ok) return;
		expect(empty.error.code).toBe("BODY_REQUIRED");

		const tooLong = await h.fate(
			{
				kind: "mutation",
				name: "comment.edit",
				input: {id, body: "x".repeat(5_001)},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(tooLong.ok).toBe(false);
		if (tooLong.ok) return;
		expect(tooLong.error.code).toBe("BODY_TOO_LONG");
	});
});

describe("pano comments — soft-delete placeholder semantics", () => {
	it("deleting a leaf comment removes it from the feed and decrements commentCount", async () => {
		const postId = await seedPost(`panocomm-${STAMP} leaf-delete target`);
		const leaf = await seedComment(postId, "leaf comment to be removed");
		await seedComment(postId, "the survivor stays");
		expect(await commentCount(postId)).toBe(2);

		const deleted = await h.fate(
			{kind: "mutation", name: "comment.delete", input: {id: leaf}, select: ["id", "commentCount"]},
			{cookie: author.cookie},
		);
		expect(deleted.ok).toBe(true);
		if (!deleted.ok) return;
		const post = deleted.data as PostNode;
		expect(post.__typename).toBe("Post");
		expect(post.id).toBe(postId);
		expect(post.commentCount).toBe(1);

		// The leaf row is gone from the feed; the survivor remains.
		const comments = await readComments(postId);
		expect(comments.some((c) => c.id === leaf)).toBe(false);
		expect(comments).toHaveLength(1);
		expect(await commentCount(postId)).toBe(1);
	});

	it("deleting a comment with replies leaves a [silindi] tombstone in the feed; replies survive", async () => {
		const postId = await seedPost(`panocomm-${STAMP} parent-delete target`);
		const parent = await seedComment(postId, "parent comment with a reply");
		const reply = await seedComment(postId, "the reply that keeps the parent alive", {
			cookie: intruder.cookie,
			parentId: parent,
		});
		expect(await commentCount(postId)).toBe(2);

		const deleted = await h.fate(
			{
				kind: "mutation",
				name: "comment.delete",
				input: {id: parent},
				select: ["id", "commentCount"],
			},
			{cookie: author.cookie},
		);
		expect(deleted.ok).toBe(true);
		if (!deleted.ok) return;
		// The parent stays in the feed as a tombstone, but `commentCount` still
		// decrements on a soft-delete (the service counts a delete regardless of
		// the reply-aware tombstone) → 2 → 1.
		expect((deleted.data as PostNode).commentCount).toBe(1);

		const comments = await readComments(postId);
		// Parent stays as a [silindi] tombstone with an empty authorId.
		const parentRow = comments.find((c) => c.id === parent);
		expect(parentRow).toBeDefined();
		expect(parentRow!.body).toBe("[silindi]");
		expect(parentRow!.authorId).toBe("");
		// The reply still carries its original body + parent link.
		const replyRow = comments.find((c) => c.id === reply);
		expect(replyRow).toBeDefined();
		expect(replyRow!.body).toBe("the reply that keeps the parent alive");
		expect(replyRow!.parentId).toBe(parent);
	});

	it("re-deleting a parent-with-replies tombstone is an idempotent no-op", async () => {
		const postId = await seedPost(`panocomm-${STAMP} idempotent-delete target`);
		const parent = await seedComment(postId, "parent that becomes a tombstone");
		await seedComment(postId, "reply keeping parent alive", {parentId: parent});

		const first = await h.fate(
			{
				kind: "mutation",
				name: "comment.delete",
				input: {id: parent},
				select: ["id", "commentCount"],
			},
			{cookie: author.cookie},
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		// First soft-delete decrements the count (2 → 1) but keeps the tombstone.
		expect((first.data as PostNode).commentCount).toBe(1);

		// Second delete on the already-tombstoned parent is an idempotent no-op:
		// the service short-circuits on the already-deleted row, so the count is
		// NOT decremented again (stays 1).
		const second = await h.fate(
			{
				kind: "mutation",
				name: "comment.delete",
				input: {id: parent},
				select: ["id", "commentCount"],
			},
			{cookie: author.cookie},
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect((second.data as PostNode).commentCount).toBe(1);

		// Still exactly one tombstone in the feed.
		const comments = await readComments(postId);
		const tombstones = comments.filter((c) => c.id === parent && c.body === "[silindi]");
		expect(tombstones).toHaveLength(1);
	});
});

describe("pano comments — vote idempotency / round-trip", () => {
	it("two consecutive votes are idempotent (score stays 1, myVote 1)", async () => {
		const postId = await seedPost(`panocomm-${STAMP} comment vote idem target`);
		const id = await seedComment(postId, "a votable comment");

		const first = await h.fate(
			{kind: "mutation", name: "comment.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((first.data as CommentNode).score).toBe(1);
		expect((first.data as CommentNode).myVote).toBe(1);

		const second = await h.fate(
			{kind: "mutation", name: "comment.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect((second.data as CommentNode).score).toBe(1);
		expect((second.data as CommentNode).myVote).toBe(1);
	});

	it("vote → retract → vote nets score 1, myVote 1", async () => {
		const postId = await seedPost(`panocomm-${STAMP} comment vote rt target`);
		const id = await seedComment(postId, "a round-trippable comment");

		await h.fate(
			{kind: "mutation", name: "comment.vote", input: {id}, select: ["id"]},
			{cookie: voter.cookie},
		);
		await h.fate(
			{kind: "mutation", name: "comment.retractVote", input: {id}, select: ["id"]},
			{cookie: voter.cookie},
		);
		const final = await h.fate(
			{kind: "mutation", name: "comment.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(final.ok).toBe(true);
		if (!final.ok) return;
		expect((final.data as CommentNode).score).toBe(1);
		expect((final.data as CommentNode).myVote).toBe(1);
	});

	it("retracting a vote that was never cast is a no-op (score stays 0)", async () => {
		const postId = await seedPost(`panocomm-${STAMP} comment retract noop target`);
		const id = await seedComment(postId, "a never-voted comment");

		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.retractVote",
				input: {id},
				select: ["id", "score", "myVote"],
			},
			{cookie: voter.cookie},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect((result.data as CommentNode).score).toBe(0);
		expect((result.data as CommentNode).myVote).toBeNull();
	});

	it("retracting a vote then re-reading the comment shows score 0 / myVote null", async () => {
		const postId = await seedPost(`panocomm-${STAMP} comment retract roundtrip target`);
		const id = await seedComment(postId, "a comment to vote then retract");

		await h.fate(
			{kind: "mutation", name: "comment.vote", input: {id}, select: ["id"]},
			{cookie: voter.cookie},
		);
		const retracted = await h.fate(
			{
				kind: "mutation",
				name: "comment.retractVote",
				input: {id},
				select: ["id", "score", "myVote"],
			},
			{cookie: voter.cookie},
		);
		expect(retracted.ok).toBe(true);
		if (!retracted.ok) return;
		expect((retracted.data as CommentNode).score).toBe(0);
		expect((retracted.data as CommentNode).myVote).toBeNull();
	});

	it("retracting a missing comment surfaces COMMENT_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.retractVote",
				input: {id: `comm_${STAMP}_does_not_exist`},
				select: ["id"],
			},
			{cookie: voter.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("COMMENT_NOT_FOUND");
	});
});

describe("pano comments — connection edge cases", () => {
	it("reply-aware feed: leaf-deleted is gone, parent-with-replies stays as a tombstone", async () => {
		const postId = await seedPost(`panocomm-${STAMP} reply-aware feed target`);
		const c0 = await seedComment(postId, "comment 0 — will be parent of a reply");
		const c1 = await seedComment(postId, "comment 1 — stays live");
		const c2 = await seedComment(postId, "comment 2 — will be leaf-deleted");
		const reply = await seedComment(postId, "child of comment 0", {parentId: c0});

		// Delete a parent-with-replies (soft) and a leaf (hard).
		await h.fate(
			{kind: "mutation", name: "comment.delete", input: {id: c0}, select: ["id"]},
			{cookie: author.cookie},
		);
		await h.fate(
			{kind: "mutation", name: "comment.delete", input: {id: c2}, select: ["id"]},
			{cookie: author.cookie},
		);

		const comments = await readComments(postId);
		const ids = comments.map((c) => c.id);
		// c0 stays as tombstone, c1 live, reply live; c2 (leaf) gone.
		expect(ids).toContain(c0);
		expect(ids).toContain(c1);
		expect(ids).toContain(reply);
		expect(ids).not.toContain(c2);
		expect(comments.find((c) => c.id === c0)!.body).toBe("[silindi]");
		expect(comments.find((c) => c.id === c1)!.body).toBe("comment 1 — stays live");

		// No totalCount on the wire — re-express "feed length" via the id-union size.
		expect(new Set(ids).size).toBe(3);
	});

	it("a stale cursor (a never-existed comment id) yields an empty page", async () => {
		const postId = await seedPost(`panocomm-${STAMP} stale-cursor target`);
		for (let i = 0; i < 3; i++) await seedComment(postId, `comment ${i} for stale cursor test`);

		const page = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2, after: `comm_${STAMP}_never_existed`}},
			select: ["id", "comments.id"],
		});
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		const conn = (page.data as {comments: Connection<CommentNode>}).comments;
		expect(conn.items).toHaveLength(0);
		expect(conn.pagination.hasNext).toBe(false);
		expect(conn.pagination.nextCursor).toBeUndefined();
	});

	it("when the `after` row is hard-removed between pages, the next page is empty", async () => {
		const postId = await seedPost(`panocomm-${STAMP} removed-cursor target`);
		const ids: string[] = [];
		for (let i = 0; i < 4; i++)
			ids.push(await seedComment(postId, `comment ${i} removed-cursor test`));

		// Page 1: first 2, cursor is the second id.
		const page1 = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2}},
			select: ["id", "comments.id"],
		});
		expect(page1.ok).toBe(true);
		if (!page1.ok) return;
		const conn1 = (page1.data as {comments: Connection<CommentNode>}).comments;
		expect(conn1.items.map((e) => e.node.id)).toEqual(ids.slice(0, 2));
		expect(conn1.pagination.hasNext).toBe(true);
		const cursor = conn1.pagination.nextCursor;
		expect(cursor).toBe(ids[1]);

		// Hard-delete the cursor comment (a leaf → row removed).
		await h.fate(
			{kind: "mutation", name: "comment.delete", input: {id: ids[1]!}, select: ["id"]},
			{cookie: author.cookie},
		);

		// Page 2 after the now-removed cursor: the keyset finds no anchor row → empty.
		const page2 = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId, comments: {first: 2, after: cursor}},
			select: ["id", "comments.id"],
		});
		expect(page2.ok).toBe(true);
		if (!page2.ok) return;
		const conn2 = (page2.data as {comments: Connection<CommentNode>}).comments;
		expect(conn2.items).toHaveLength(0);
		expect(conn2.pagination.hasNext).toBe(false);
		expect(conn2.pagination.nextCursor).toBeUndefined();
	});
});

// covered by pano-read.test.ts: chronological keyset paging through every comment
//   with a stable id cursor (no skips/dupes across pages).
// covered by pano-mutations.test.ts: comment.add top-level + commentCount bump,
//   nested reply + commentCount bump, PARENT_NOT_FOUND (missing + cross-post),
//   POST_NOT_FOUND, anonymous → UNAUTHORIZED, BODY_REQUIRED/BODY_TOO_LONG on add,
//   comment.vote/retractVote happy path (myVote stamped), comment.edit happy path,
//   comment.vote on unknown id → COMMENT_NOT_FOUND, leaf comment.delete returning
//   the re-resolved parent Post with the decremented commentCount.
// not portable black-box: comment_vote / user_vote row counts, total_karma
//   read-backs, comment_view body_excerpt + deleted_at columns, the
//   `{deleted, hasReplies, placeholder}` / `changed` service-return flags —
//   re-expressed via the re-resolved Comment, the comments feed (tombstone body
//   `[silindi]` + empty authorId), and `post(id).commentCount` over `/fate`.
