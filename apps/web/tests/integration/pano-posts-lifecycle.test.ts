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
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one D1 is
 * shared across every migrated file: every title/host/email/synthetic-id is prefixed with
 * `NS` (this file's deterministic `nsToken`). Isolation on the shared D1 is by READ SHAPE —
 * every lifecycle assertion (after submit/edit/delete/vote) re-resolves THIS test's own post
 * by id (`post(idOrSlug: id)`), never a global feed. The two presence/absence checks that DO
 * read a feed (id-union row count; "deleted post drops out") are scoped by an NS-prefixed
 * HOST, so `posts(host)` returns only this file's (and this test's) rows — the host-scoping IS
 * the namespace. No assertion observes another file's data.
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
	body: string | null;
	score: number;
	commentCount: number;
	myVote: boolean | null;
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
	author = await h.signUp(`${NS}-author@test.local`, "hunter2hunter2", "yazar");
	voter = await h.signUp(`${NS}-voter@test.local`, "hunter2hunter2", "oycu");
});

describe("pano posts — edit field-subset re-resolution", () => {
	it("a title-only edit re-resolves the new title and leaves the body intact", async () => {
		const id = await seedPost({
			title: `${NS} title-only before`,
			body: "untouched body",
		});
		const edited = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, title: `${NS} title-only after`},
				select: ["id", "title", "body"],
			},
			{cookie: author.cookie},
		);
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		expect((edited.data as PostNode).title).toBe(`${NS} title-only after`);
		expect((edited.data as PostNode).body).toBe("untouched body");

		// Re-resolve independently: the body did not change.
		const post = await readPost(id);
		expect(post).not.toBeNull();
		expect(post!.title).toBe(`${NS} title-only after`);
		expect(post!.body).toBe("untouched body");
	});

	it("a body-only edit re-resolves the new body and leaves the title intact", async () => {
		const id = await seedPost({
			title: `${NS} body-only fixed title`,
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
		expect((edited.data as PostNode).title).toBe(`${NS} body-only fixed title`);
		expect((edited.data as PostNode).body).toBe("rewritten body");

		const post = await readPost(id);
		expect(post).not.toBeNull();
		expect(post!.title).toBe(`${NS} body-only fixed title`);
		expect(post!.body).toBe("rewritten body");
	});
});

describe("pano posts — edit validation", () => {
	it("an edit with neither title nor body surfaces TITLE_REQUIRED", async () => {
		const id = await seedPost({title: `${NS} edit-empty`});
		const result = await h.fate(
			{kind: "mutation", name: "post.edit", input: {id}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TITLE_REQUIRED");
	});

	// The pure title/body content codes (TITLE_REQUIRED on a blank title,
	// TITLE_TOO_LONG, BODY_TOO_LONG) are unit-tested off-DB in
	// worker/features/pano/submit-validation.unit.test.ts (ADR 0082) — the
	// validatePostTitle/validatePostBody editPost calls. The neither-field guard
	// above is kept: it runs after the DB read and is editPost's own structural
	// rule, not a pure validator.

	it("editing an unknown post id surfaces POST_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id: `post_${NS}_does_not_exist`, title: "x"},
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
	it("two consecutive votes are idempotent (score stays 1, myVote true)", async () => {
		const id = await seedPost({title: `${NS} vote idem`});

		const first = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((first.data as PostNode).score).toBe(1);
		expect((first.data as PostNode).myVote).toBe(true);

		const second = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect((second.data as PostNode).score).toBe(1);
		expect((second.data as PostNode).myVote).toBe(true);

		// Re-resolve: the score holds at 1.
		const post = await readPost(id);
		expect(post!.score).toBe(1);
	});

	it("vote → retract → vote nets score 1, myVote true", async () => {
		const id = await seedPost({title: `${NS} vote rt`});

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
		expect((final.data as PostNode).myVote).toBe(true);
	});

	it("retracting a vote that was never cast is a no-op (score stays 0)", async () => {
		const id = await seedPost({title: `${NS} retract noop`});
		const result = await h.fate(
			{kind: "mutation", name: "post.retractVote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect((result.data as PostNode).score).toBe(0);
		expect((result.data as PostNode).myVote).toBe(false);
	});

	it("retracting a vote on a missing post surfaces POST_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.retractVote",
				input: {id: `post_${NS}_does_not_exist`},
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
		const id = await seedPost({title: `${NS} delete idem`});

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

	// #1639: post.delete must never surface a raw internal_server_error — a
	// never-existed id short-circuits to the graceful {__typename,id} eviction ref,
	// not an undeclared 500 (the service returns `deleted:false` for a missing row).
	it("deleting a never-existed post is a graceful no-op, not internal_server_error", async () => {
		const res = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id: `${NS}-never-existed`}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(res.ok).toBe(true);
		if (!res.ok) {
			expect(res.error.code).not.toBe("INTERNAL_SERVER_ERROR");
			return;
		}
		expect((res.data as PostNode).__typename).toBe("Post");
	});
});

describe("pano posts — connection edges", () => {
	it("a host-scoped feed returns exactly the seeded rows (no totalCount; id-union)", async () => {
		const host = `${NS}-hostcount.example.com`;
		const seeded: string[] = [];
		for (let i = 0; i < 3; i++) {
			seeded.push(await seedPost({title: `${NS} hostcount ${i}`, url: `https://${host}/p/${i}`}));
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
		// No totalCount on the wire — re-express the row count via the id-union. The
		// NS-prefixed host scopes the feed to exactly this test's three rows.
		expect(new Set(ids).size).toBe(3);
		expect([...ids].sort()).toEqual([...seeded].sort());
		expect(conn.pagination.hasNext).toBe(false);
		// The last item's cursor is the last node id.
		expect(conn.items[conn.items.length - 1]!.cursor).toBe(ids[ids.length - 1]);
	});

	it("a deleted post drops out of its host-scoped feed", async () => {
		const host = `${NS}-dropout.example.com`;
		const keep = await seedPost({
			title: `${NS} dropout keep`,
			url: `https://${host}/keep`,
		});
		const gone = await seedPost({
			title: `${NS} dropout gone`,
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
		// The NS-prefixed host scopes the presence/absence check to this test's own rows.
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
//   read-backs, post_record body_excerpt columns, hot_score, pano_stats
//   total_posts decrement, the `{deleted, changed}` service-return flags —
//   re-expressed via the re-resolved Post (title/body/score/myVote) and the
//   host-scoped feed over `/fate`.
