/**
 * pano post lifecycle DEPTH — black-box against the deployed worker `/fate`
 * route (ADR 0026–0031).
 *
 * Ports the depth surface of the pre-alchemy post suites that drove the `Pano`
 * Effect service directly inside workerd:
 *   - `pano-edit-delete-post.test.ts` — post ownership (covered by Wave 2),
 *     edit validation codes, edit field-subset re-resolution (title-only edit
 *     leaves body intact and vice versa), idempotent re-delete.
 *   - `pano-vote-post.test.ts` — post vote idempotency, round-trip,
 *     retract-on-never-voted no-op.
 *   - remaining `pano-post-connection.test.ts` edges not covered by Wave-2
 *     `pano-read.test.ts` (the `totalCount` row count re-expressed via the
 *     id-union of a host-scoped feed).
 *
 * Everything is observed over HTTP. Author identity comes from the session
 * (`h.signUp`); a vote-from-another-user test uses a second cookie. The old
 * service-return flags (`{deleted, changed}`, `hot_score`, `updatedAt`) are NOT
 * on the wire; behavior is re-expressed via the re-resolved Post + the feed
 * over `/fate`. The connection envelope has NO `totalCount`, so the old
 * `totalCount` assertion is dropped and re-expressed via the id-union size.
 *
 * D1 is shared across all test files (one deploy), so every title/host/email is
 * uniquely prefixed (`panopost-${Date.now()}-…`).
 */
import {beforeAll, describe, expect, it} from "vitest";
import {harness} from "./_harness.ts";

const h = harness();

const STAMP = Date.now();

interface PostNode {
	__typename: string;
	id: string;
	title: string;
	body: string | null;
	score: number;
	commentCount: number;
	myVote: number | null;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

let author: {userId: string; cookie: string};
let voter: {userId: string; cookie: string};

/** Submit a post under the author cookie; assert success; return its id. */
async function seedPost(input: {
	title: string;
	url?: string;
	body?: string;
	tags?: Array<{kind: string}>;
}): Promise<string> {
	const r = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {...input, tags: input.tags ?? [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: author.cookie},
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("seedPost failed");
	return (r.data as PostNode).id;
}

/** Re-resolve a post's title + body over `/fate`. */
async function readPost(id: string): Promise<PostNode | null> {
	const r = await h.fate({
		kind: "query",
		name: "post",
		args: {idOrSlug: id},
		select: ["id", "title", "body", "score"],
	});
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("readPost failed");
	return r.data as PostNode | null;
}

beforeAll(async () => {
	author = await h.signUp(`panopost-${STAMP}-author@test.local`, "hunter2hunter2", "yazar");
	voter = await h.signUp(`panopost-${STAMP}-voter@test.local`, "hunter2hunter2", "oycu");
});

describe("pano posts — edit field-subset re-resolution", () => {
	it("a title-only edit re-resolves the new title and leaves the body intact", async () => {
		const id = await seedPost({
			title: `panopost-${STAMP} title-only before`,
			body: "untouched body",
		});
		const edited = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, title: `panopost-${STAMP} title-only after`},
				select: ["id", "title", "body"],
			},
			{cookie: author.cookie},
		);
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		expect((edited.data as PostNode).title).toBe(`panopost-${STAMP} title-only after`);
		expect((edited.data as PostNode).body).toBe("untouched body");

		// Re-resolve independently: the body did not change.
		const post = await readPost(id);
		expect(post).not.toBeNull();
		expect(post!.title).toBe(`panopost-${STAMP} title-only after`);
		expect(post!.body).toBe("untouched body");
	});

	it("a body-only edit re-resolves the new body and leaves the title intact", async () => {
		const id = await seedPost({
			title: `panopost-${STAMP} body-only fixed title`,
			body: "original body",
		});
		const edited = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, body: "rewritten body"},
				select: ["id", "title", "body"],
			},
			{cookie: author.cookie},
		);
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		expect((edited.data as PostNode).title).toBe(`panopost-${STAMP} body-only fixed title`);
		expect((edited.data as PostNode).body).toBe("rewritten body");

		const post = await readPost(id);
		expect(post).not.toBeNull();
		expect(post!.title).toBe(`panopost-${STAMP} body-only fixed title`);
		expect(post!.body).toBe("rewritten body");
	});
});

describe("pano posts — edit validation", () => {
	it("an edit with neither title nor body surfaces TITLE_REQUIRED", async () => {
		const id = await seedPost({title: `panopost-${STAMP} edit-empty`});
		const result = await h.fate(
			{kind: "mutation", name: "post.edit", input: {id}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TITLE_REQUIRED");
	});

	it("an edit with a blank title surfaces TITLE_REQUIRED", async () => {
		const id = await seedPost({title: `panopost-${STAMP} edit-blank-title`});
		const result = await h.fate(
			{kind: "mutation", name: "post.edit", input: {id, title: "   "}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TITLE_REQUIRED");
	});

	it("an edit with a title over 200 chars surfaces TITLE_TOO_LONG", async () => {
		const id = await seedPost({title: `panopost-${STAMP} edit-title-long`});
		const result = await h.fate(
			{kind: "mutation", name: "post.edit", input: {id, title: "x".repeat(201)}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TITLE_TOO_LONG");
	});

	it("an edit with a body over 10000 chars surfaces BODY_TOO_LONG", async () => {
		const id = await seedPost({title: `panopost-${STAMP} edit-body-long`});
		const result = await h.fate(
			{kind: "mutation", name: "post.edit", input: {id, body: "x".repeat(10_001)}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("BODY_TOO_LONG");
	});

	it("editing an unknown post id surfaces POST_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id: `post_${STAMP}_does_not_exist`, title: "x"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("POST_NOT_FOUND");
	});
});

describe("pano posts — vote idempotency / round-trip", () => {
	it("two consecutive votes are idempotent (score stays 1, myVote 1)", async () => {
		const id = await seedPost({title: `panopost-${STAMP} vote idem`});

		const first = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((first.data as PostNode).score).toBe(1);
		expect((first.data as PostNode).myVote).toBe(1);

		const second = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect((second.data as PostNode).score).toBe(1);
		expect((second.data as PostNode).myVote).toBe(1);

		// Re-resolve: the score holds at 1.
		const post = await readPost(id);
		expect(post!.score).toBe(1);
	});

	it("vote → retract → vote nets score 1, myVote 1", async () => {
		const id = await seedPost({title: `panopost-${STAMP} vote rt`});

		await h.fate(
			{kind: "mutation", name: "post.vote", input: {id}, select: ["id"]},
			{cookie: voter.cookie},
		);
		await h.fate(
			{kind: "mutation", name: "post.retractVote", input: {id}, select: ["id"]},
			{cookie: voter.cookie},
		);
		const final = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(final.ok).toBe(true);
		if (!final.ok) return;
		expect((final.data as PostNode).score).toBe(1);
		expect((final.data as PostNode).myVote).toBe(1);
	});

	it("retracting a vote that was never cast is a no-op (score stays 0)", async () => {
		const id = await seedPost({title: `panopost-${STAMP} retract noop`});
		const result = await h.fate(
			{kind: "mutation", name: "post.retractVote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect((result.data as PostNode).score).toBe(0);
		expect((result.data as PostNode).myVote).toBeNull();
	});

	it("retracting a vote on a missing post surfaces POST_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.retractVote",
				input: {id: `post_${STAMP}_does_not_exist`},
				select: ["id"],
			},
			{cookie: voter.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("POST_NOT_FOUND");
	});
});

describe("pano posts — delete idempotency", () => {
	it("re-deleting an already-deleted post is an idempotent no-op (same {__typename,id} ref)", async () => {
		const id = await seedPost({title: `panopost-${STAMP} delete idem`});

		const first = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((first.data as PostNode).__typename).toBe("Post");
		expect((first.data as PostNode).id).toBe(id);

		// The row is gone; a re-resolve is null.
		expect(await readPost(id)).toBeNull();

		// Re-deleting the removed post is an idempotent no-op: the resolver still
		// returns the bare {__typename, id} eviction ref (the service short-circuits
		// on the missing row without raising).
		const second = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect((second.data as PostNode).__typename).toBe("Post");
		expect((second.data as PostNode).id).toBe(id);

		// Still gone after the second delete.
		expect(await readPost(id)).toBeNull();
	});
});

describe("pano posts — connection edges", () => {
	it("a host-scoped feed returns exactly the seeded rows (no totalCount; id-union)", async () => {
		const host = `panopost-${STAMP}-hostcount.example.com`;
		const seeded: string[] = [];
		for (let i = 0; i < 3; i++) {
			seeded.push(
				await seedPost({title: `panopost-${STAMP} hostcount ${i}`, url: `https://${host}/p/${i}`}),
			);
		}

		const page = await h.fate({
			kind: "list",
			name: "posts",
			args: {first: 100, host},
			select: ["id"],
		});
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		const conn = page.data as Connection<PostNode>;
		const ids = conn.items.map((e) => e.node.id);
		// No totalCount on the wire — re-express the row count via the id-union.
		expect(new Set(ids).size).toBe(3);
		expect([...ids].sort()).toEqual([...seeded].sort());
		expect(conn.pagination.hasNext).toBe(false);
		// The last item's cursor is the last node id.
		expect(conn.items[conn.items.length - 1]!.cursor).toBe(ids[ids.length - 1]);
	});

	it("a deleted post drops out of its host-scoped feed", async () => {
		const host = `panopost-${STAMP}-dropout.example.com`;
		const keep = await seedPost({
			title: `panopost-${STAMP} dropout keep`,
			url: `https://${host}/keep`,
		});
		const gone = await seedPost({
			title: `panopost-${STAMP} dropout gone`,
			url: `https://${host}/gone`,
		});

		await h.fate(
			{kind: "mutation", name: "post.delete", input: {id: gone}, select: ["id"]},
			{cookie: author.cookie},
		);

		const page = await h.fate({
			kind: "list",
			name: "posts",
			args: {first: 100, host},
			select: ["id"],
		});
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		const ids = (page.data as Connection<PostNode>).items.map((e) => e.node.id);
		expect(ids).toContain(keep);
		expect(ids).not.toContain(gone);
	});
});

// covered by pano-mutations.test.ts: post.edit happy path (title alone, body
//   alone) returning the re-resolved Post, non-author edit → UNAUTHORIZED (title
//   unchanged), post.delete happy path ({__typename,id} then post(id) null),
//   non-author delete → UNAUTHORIZED (post survives), post.vote/retractVote happy
//   path (score + myVote), post.vote on missing id → POST_NOT_FOUND, post.submit
//   validation codes (TITLE_REQUIRED / TITLE_TOO_LONG / URL_INVALID /
//   BODY_TOO_LONG / TAGS_REQUIRED / TAG_INVALID) and anonymous → UNAUTHORIZED.
// covered by pano-read.test.ts: posts connection keyset walk through every row
//   exactly once (sort:new newest-first, stable id cursor, no skips/dupes) and
//   the ghost-cursor empty-page edge.
// not portable black-box: post_vote / user_vote row counts, total_karma
//   read-backs, post_summary body_excerpt columns, hot_score, pano_stats
//   total_posts decrement, the `{deleted, changed}` service-return flags —
//   re-expressed via the re-resolved Post (title/body/score/myVote) and the
//   host-scoped feed over `/fate`.
