/**
 * pano mutations — black-box against the deployed worker `/fate` route
 * (ADR 0026–0031).
 *
 * Ports the write surface of three pre-alchemy suites that drove the pano
 * mutation resolvers / `Pano` service directly inside workerd:
 *   - `fate-pano-mutations.test.ts` — post.submit/vote/retractVote/edit/delete,
 *     comment.add/vote/retractVote/edit/delete, and wire-error parity
 *     (`TAGS_REQUIRED`, `POST_NOT_FOUND`, `COMMENT_NOT_FOUND`, `UNAUTHORIZED`).
 *   - `pano-submit-post.test.ts` — submit happy path + post validation codes
 *     (`TITLE_REQUIRED`, `TITLE_TOO_LONG`, `URL_INVALID`, `BODY_TOO_LONG`,
 *     `TAGS_REQUIRED`, `TAG_INVALID`).
 *   - `pano-add-comment.test.ts` — top-level comment + commentCount bump, nested
 *     reply, comment validation codes (`BODY_REQUIRED`, `BODY_TOO_LONG`,
 *     `PARENT_NOT_FOUND` for missing + cross-post parent, `POST_NOT_FOUND`).
 *
 * Everything is observed over HTTP. Author identity comes from the session
 * (`h.signUp`), not explicit `authorId`/`authorName`, so submit input is
 * `{title, url?, body?, tags}`. Wire codes are the UPCASED pano sub-codes
 * (`title_required` → `TITLE_REQUIRED`). D1 row assertions (post_summary /
 * comment_view columns, body_excerpt) are dropped; behavior is re-expressed by
 * re-resolving the entity over `/fate` (e.g. `commentCount` via `post(id)`).
 * Ownership uses two real users: the author creates, the intruder's cookie
 * attempts edit/delete → `UNAUTHORIZED`.
 *
 * D1 is shared (one deploy) — every title/host/email is uniquely prefixed
 * (`panomut-${Date.now()}-…`).
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now();

interface PostNode {
	__typename: string;
	id: string;
	title: string;
	body: string | null;
	author: string;
	authorId: string;
	score: number;
	commentCount: number;
	myVote: number | null;
	tags: Array<{kind: string; label: string}>;
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

let author: {userId: string; cookie: string};
let intruder: {userId: string; cookie: string};

const POST_SELECT = [
	"id",
	"title",
	"author",
	"authorId",
	"score",
	"commentCount",
	"myVote",
	"tags",
];
const COMMENT_SELECT = ["id", "parentId", "body", "author", "authorId", "score", "myVote"];

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

beforeAll(async () => {
	author = await h.signUp(`panomut-${STAMP}-author@test.local`, "hunter2hunter2", "yazar");
	intruder = await h.signUp(`panomut-${STAMP}-intruder@test.local`, "hunter2hunter2", "davetsiz");
});

describe("pano mutations — post.submit", () => {
	it("writes and returns the re-resolved Post", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `panomut-${STAMP} a submitted post`,
					body: "the post body",
					tags: [{kind: "tartışma"}],
				},
				select: POST_SELECT,
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const post = result.data as PostNode;
		expect(post.__typename).toBe("Post");
		expect(post.id).toBeTruthy();
		expect(post.id).toMatch(/^post_/);
		expect(post.title).toBe(`panomut-${STAMP} a submitted post`);
		expect(post.author).toBe("yazar");
		expect(post.authorId).toBe(author.userId);
		expect(post.score).toBe(0);
		expect(post.commentCount).toBe(0);
		expect(post.myVote).toBeNull();
		expect(post.tags.map((t) => t.kind)).toEqual(["tartışma"]);
	});

	it("empty title surfaces TITLE_REQUIRED", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "   ", tags: [{kind: "tartışma"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TITLE_REQUIRED");
	});

	it("titles over 200 chars surface TITLE_TOO_LONG", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "x".repeat(201), tags: [{kind: "tartışma"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TITLE_TOO_LONG");
	});

	it("invalid URLs surface URL_INVALID", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "valid title", url: "not a url", tags: [{kind: "tartışma"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("URL_INVALID");
	});

	it("bodies over 10000 chars surface BODY_TOO_LONG", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "valid title", body: "x".repeat(10_001), tags: [{kind: "tartışma"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("BODY_TOO_LONG");
	});

	it("an empty tag list surfaces TAGS_REQUIRED", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "valid title", tags: []},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TAGS_REQUIRED");
	});

	it("a tag outside the fixed enum surfaces TAG_INVALID", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {title: "valid title", tags: [{kind: "haber"}]},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TAG_INVALID");
	});

	it("anonymous writes surface UNAUTHORIZED", async () => {
		const result = await h.fate({
			kind: "mutation",
			name: "post.submit",
			input: {title: "nope", tags: [{kind: "soru"}]},
			select: ["id"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});

describe("pano mutations — post.vote / retractVote", () => {
	it("vote then retractVote return the entity with myVote + score", async () => {
		const id = await seedPost({title: `panomut-${STAMP} a votable post`, tags: [{kind: "soru"}]});

		const voted = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: author.cookie},
		);
		expect(voted.ok).toBe(true);
		if (!voted.ok) return;
		expect((voted.data as PostNode).score).toBe(1);
		expect((voted.data as PostNode).myVote).toBe(1);

		const retracted = await h.fate(
			{kind: "mutation", name: "post.retractVote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: author.cookie},
		);
		expect(retracted.ok).toBe(true);
		if (!retracted.ok) return;
		expect((retracted.data as PostNode).score).toBe(0);
		expect((retracted.data as PostNode).myVote).toBeNull();
	});

	it("voting a missing post surfaces POST_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.vote",
				input: {id: `post_${STAMP}_does_not_exist`},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("POST_NOT_FOUND");
	});
});

describe("pano mutations — post.edit / post.delete", () => {
	it("edit returns the edited entity (title alone)", async () => {
		const id = await seedPost({title: `panomut-${STAMP} before edit`, tags: [{kind: "meta"}]});
		const edited = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, title: `panomut-${STAMP} after edit`},
				select: ["id", "title"],
			},
			{cookie: author.cookie},
		);
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		expect((edited.data as PostNode).id).toBe(id);
		expect((edited.data as PostNode).title).toBe(`panomut-${STAMP} after edit`);
	});

	it("edit can change the body alone", async () => {
		const id = await seedPost({
			title: `panomut-${STAMP} body-edit`,
			body: "original body",
			tags: [{kind: "meta"}],
		});
		const edited = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, body: "edited body"},
				select: ["id", "title", "body"],
			},
			{cookie: author.cookie},
		);
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		expect((edited.data as PostNode).id).toBe(id);
		expect((edited.data as PostNode).title).toBe(`panomut-${STAMP} body-edit`);
		expect((edited.data as PostNode).body).toBe("edited body");
	});

	it("a non-author edit is rejected with UNAUTHORIZED; the title is unchanged", async () => {
		const id = await seedPost({title: `panomut-${STAMP} owned title`, tags: [{kind: "meta"}]});
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.edit",
				input: {id, title: "i should not be able to write this"},
				select: ["id"],
			},
			{cookie: intruder.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");

		const detail = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: id},
			select: ["id", "title"],
		});
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		expect((detail.data as PostNode).title).toBe(`panomut-${STAMP} owned title`);
	});

	it("delete returns a bare {__typename, id} ref; post(id) then resolves null", async () => {
		const id = await seedPost({title: `panomut-${STAMP} to be deleted`, tags: [{kind: "meta"}]});
		const deleted = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(deleted.ok).toBe(true);
		if (!deleted.ok) return;
		expect((deleted.data as PostNode).__typename).toBe("Post");
		expect((deleted.data as PostNode).id).toBe(id);

		// The post is gone: a detail read resolves null.
		const detail = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: id},
			select: ["id"],
		});
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		expect(detail.data).toBeNull();
	});

	it("a non-author delete is rejected with UNAUTHORIZED; the post survives", async () => {
		const id = await seedPost({title: `panomut-${STAMP} defended`, tags: [{kind: "meta"}]});
		const result = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id}, select: ["id"]},
			{cookie: intruder.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");

		const detail = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: id},
			select: ["id"],
		});
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		expect((detail.data as PostNode | null)?.id).toBe(id);
	});
});

describe("pano mutations — comment.add", () => {
	it("adds a top-level comment and returns the re-resolved Comment", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} comment target`});
		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "first top-level comment on the post."},
				select: COMMENT_SELECT,
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const comment = result.data as CommentNode;
		expect(comment.__typename).toBe("Comment");
		expect(comment.id).toBeTruthy();
		expect(comment.id).toMatch(/^comm_/);
		expect(comment.parentId).toBeNull();
		expect(comment.body).toContain("first top-level comment");
		expect(comment.author).toBe("yazar");
		expect(comment.authorId).toBe(author.userId);
		expect(comment.score).toBe(0);
		expect(comment.myVote).toBeNull();

		// It bumps the parent post's commentCount (re-resolve the post).
		const detail = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId},
			select: ["id", "commentCount"],
		});
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		expect((detail.data as PostNode).commentCount).toBe(1);
	});

	it("accepts a nested reply with a valid parentId and bumps commentCount to 2", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} nested target`});

		const parent = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "parent comment"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(parent.ok).toBe(true);
		if (!parent.ok) return;
		const parentId = (parent.data as CommentNode).id;

		const reply = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "nested reply", parentId},
				select: ["id", "parentId"],
			},
			{cookie: intruder.cookie},
		);
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		expect((reply.data as CommentNode).parentId).toBe(parentId);

		const detail = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId},
			select: ["id", "commentCount"],
		});
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		expect((detail.data as PostNode).commentCount).toBe(2);
	});

	it("a reply to a missing parentId surfaces PARENT_NOT_FOUND; commentCount stays 0", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} orphan target`});
		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "reply to nothing", parentId: `comm_${STAMP}_missing`},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PARENT_NOT_FOUND");

		const detail = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId},
			select: ["id", "commentCount"],
		});
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		expect((detail.data as PostNode).commentCount).toBe(0);
	});

	it("a reply whose parent lives on a different post surfaces PARENT_NOT_FOUND", async () => {
		const postA = await seedPost({title: `panomut-${STAMP} cross A`});
		const postB = await seedPost({title: `panomut-${STAMP} cross B`});

		const parentOnA = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId: postA, body: "parent on post A"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(parentOnA.ok).toBe(true);
		if (!parentOnA.ok) return;
		const parentId = (parentOnA.data as CommentNode).id;

		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId: postB, body: "reply trying to reach across", parentId},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PARENT_NOT_FOUND");
	});

	it("empty / whitespace-only bodies surface BODY_REQUIRED", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} body-required target`});
		for (const body of ["", "    ", "\n\n\t"]) {
			const result = await h.fate(
				{kind: "mutation", name: "comment.add", input: {postId, body}, select: ["id"]},
				{cookie: author.cookie},
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.code).toBe("BODY_REQUIRED");
		}
	});

	it("bodies over 5000 chars surface BODY_TOO_LONG", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} body-toolong target`});
		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "x".repeat(5_001)},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("BODY_TOO_LONG");
	});

	it("commenting on a missing post surfaces POST_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId: `post_${STAMP}_does_not_exist`, body: "hello"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("POST_NOT_FOUND");
	});

	it("anonymous comment writes surface UNAUTHORIZED", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} anon comment target`});
		const result = await h.fate({
			kind: "mutation",
			name: "comment.add",
			input: {postId, body: "nope"},
			select: ["id"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});

describe("pano mutations — comment.vote / retractVote / edit", () => {
	it("vote then retractVote return the entity with myVote stamped", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} comment vote target`});
		const added = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "a votable comment"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = (added.data as CommentNode).id;

		const voted = await h.fate(
			{kind: "mutation", name: "comment.vote", input: {id}, select: ["id", "score", "myVote"]},
			{cookie: author.cookie},
		);
		expect(voted.ok).toBe(true);
		if (!voted.ok) return;
		expect((voted.data as CommentNode).score).toBe(1);
		expect((voted.data as CommentNode).myVote).toBe(1);

		const retracted = await h.fate(
			{
				kind: "mutation",
				name: "comment.retractVote",
				input: {id},
				select: ["id", "score", "myVote"],
			},
			{cookie: author.cookie},
		);
		expect(retracted.ok).toBe(true);
		if (!retracted.ok) return;
		expect((retracted.data as CommentNode).score).toBe(0);
		expect((retracted.data as CommentNode).myVote).toBeNull();
	});

	it("edit returns the edited entity", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} comment edit target`});
		const added = await h.fate(
			{kind: "mutation", name: "comment.add", input: {postId, body: "before edit"}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = (added.data as CommentNode).id;

		const edited = await h.fate(
			{
				kind: "mutation",
				name: "comment.edit",
				input: {id, body: "after edit"},
				select: ["id", "body"],
			},
			{cookie: author.cookie},
		);
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		expect((edited.data as CommentNode).id).toBe(id);
		expect((edited.data as CommentNode).body).toBe("after edit");
	});

	it("voting a missing comment surfaces COMMENT_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "comment.vote",
				input: {id: `comm_${STAMP}_does_not_exist`},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("COMMENT_NOT_FOUND");
	});

	it("delete returns the re-resolved parent Post with the surviving commentCount", async () => {
		const postId = await seedPost({title: `panomut-${STAMP} comment delete target`});
		const a = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "to be deleted (leaf)"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "the survivor"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(a.ok).toBe(true);
		if (!a.ok) return;
		const aId = (a.data as CommentNode).id;

		const parent = await h.fate(
			{kind: "mutation", name: "comment.delete", input: {id: aId}, select: ["id", "commentCount"]},
			{cookie: author.cookie},
		);
		expect(parent.ok).toBe(true);
		if (!parent.ok) return;
		const post = parent.data as PostNode;
		expect(post.__typename).toBe("Post");
		expect(post.id).toBe(postId);
		// Two added, one (leaf) removed → one remains.
		expect(post.commentCount).toBe(1);
	});
});

// not portable black-box: pano-submit-post.test.ts D1 row-shape assertions
// (post_summary columns, tags CSV, body_excerpt) and the (author_id, created_at)
// index probe — re-expressed by re-resolving the Post over `/fate`.
// not portable black-box: pano-add-comment.test.ts comment_view row assertions
// (author_id, post_title, body_excerpt, parent_id, deleted_at) — re-expressed via
// the re-resolved Comment + the parent post's commentCount over `/fate`.
