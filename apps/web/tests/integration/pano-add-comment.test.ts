/**
 * `Pano.addComment` — Effect service surface (effect-migration task 5).
 *
 * Wire codes preserved verbatim. Validation tagged errors are checked via
 * `_tag` / `code` instead of class name / `name` field.
 */
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	type AddCommentInput,
	Pano,
	PanoLive,
	type SubmitPostInput,
} from "../../worker/features/pano/Pano";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = PanoLive.pipe(
	Layer.provideMerge(VoteLive),
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

function submitPost(input: SubmitPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.submitPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function addComment(input: AddCommentInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.addComment(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function addCommentProgram(input: AddCommentInput) {
	return Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.addComment(input);
	}).pipe(Effect.provide(TestLive));
}

async function expectFailure(
	program: Effect.Effect<unknown, unknown, never>,
	tag: string,
	code?: string,
) {
	const exit = await Effect.runPromise(Effect.exit(program));
	if (Exit.isSuccess(exit)) throw new Error("expected failure");
	const found = Cause.findError(exit.cause);
	if (found._tag !== "Success") throw new Error("expected typed failure");
	const err = found.success as {_tag?: string; code?: string};
	expect(err._tag).toBe(tag);
	if (code !== undefined) expect(err.code).toBe(code);
}

async function applyViewMigrations() {
	const sources = [baselineMigration];
	for (const src of sources) {
		const statements = src
			.split("--> statement-breakpoint")
			.map((s: string) => s.trim())
			.filter(Boolean);
		for (const stmt of statements) {
			try {
				await env.PHOENIX_DB.prepare(stmt).run();
			} catch (err) {
				const msg = String(err);
				if (
					!msg.includes("already exists") &&
					!msg.includes("duplicate column") &&
					!msg.includes("no such table") &&
					!msg.includes("no such index")
				) {
					throw err;
				}
			}
		}
	}
}

async function seedPost(opts: {authorId: string; authorName?: string; title?: string}) {
	const r = await submitPost({
		title: opts.title ?? "comment test başlık",
		body: "comment test body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "post author",
	});
	return r.postId;
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("Pano.addComment", () => {
	it("inserts a top-level comment + bumps post.commentCount + writes comment_view row", async () => {
		const postId = await seedPost({authorId: "p-author-1"});

		const result = await addComment({
			postId,
			authorId: "c-author-1",
			authorName: "commenter",
			body: "first top-level comment on the post.",
		});

		expect(result.commentId).toMatch(/^comm_/);
		expect(result.parentId).toBeNull();
		expect(result.authorName).toBe("commenter");
		expect(result.body).toContain("first top-level comment");
		expect(result.commentCount).toBe(1);

		const view = await env.PHOENIX_DB.prepare(
			"SELECT id, author_id, author_name, post_id, post_title, body, body_excerpt, score, parent_id, deleted_at FROM comment_view WHERE id = ?",
		)
			.bind(result.commentId)
			.first<{
				id: string;
				author_id: string;
				author_name: string;
				post_id: string;
				post_title: string;
				body: string;
				body_excerpt: string;
				score: number;
				parent_id: string | null;
				deleted_at: number | null;
			}>();
		expect(view).not.toBeNull();
		expect(view!.author_id).toBe("c-author-1");
		expect(view!.author_name).toBe("commenter");
		expect(view!.post_id).toBe(postId);
		expect(view!.post_title).toContain("comment test başlık");
		expect(view!.body).toContain("first top-level comment");
		expect(view!.body_excerpt).toContain("first top-level comment");
		expect(view!.score).toBe(0);
		expect(view!.parent_id).toBeNull();
		expect(view!.deleted_at).toBeNull();

		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(1);
	});

	it("accepts a nested reply with a valid parent_id", async () => {
		const postId = await seedPost({authorId: "p-author-2"});

		const parent = await addComment({
			postId,
			authorId: "c-parent",
			authorName: "parent author",
			body: "parent comment",
		});

		const reply = await addComment({
			postId,
			authorId: "c-reply",
			authorName: "reply author",
			body: "nested reply",
			parentId: parent.commentId,
		});

		expect(reply.parentId).toBe(parent.commentId);
		expect(reply.commentCount).toBe(2);

		const replyView = await env.PHOENIX_DB.prepare(
			"SELECT parent_id FROM comment_view WHERE id = ?",
		)
			.bind(reply.commentId)
			.first<{parent_id: string}>();
		expect(replyView!.parent_id).toBe(parent.commentId);

		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(2);
	});

	it("rejects a nested reply when parent_id references a missing comment", async () => {
		const postId = await seedPost({authorId: "p-author-3"});

		await expectFailure(
			addCommentProgram({
				postId,
				authorId: "c-orphan",
				authorName: "orphan",
				body: "reply to nothing",
				parentId: "comm_does_not_exist",
			}),
			"pano/CommentValidation",
			"parent_not_found",
		);

		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(0);
	});

	it("rejects a nested reply whose parent lives on a different post", async () => {
		const postA = await seedPost({authorId: "p-author-cross-a", title: "A"});
		const postB = await seedPost({authorId: "p-author-cross-b", title: "B"});

		const parentOnA = await addComment({
			postId: postA,
			authorId: "c-author-cross",
			authorName: "x",
			body: "parent on post A",
		});

		await expectFailure(
			addCommentProgram({
				postId: postB,
				authorId: "c-author-cross-2",
				authorName: "y",
				body: "reply trying to reach across",
				parentId: parentOnA.commentId,
			}),
			"pano/CommentValidation",
			"parent_not_found",
		);
	});

	it("rejects empty / whitespace-only body", async () => {
		const postId = await seedPost({authorId: "p-author-4"});
		for (const body of ["", "    ", "\n\n\t"]) {
			await expectFailure(
				addCommentProgram({
					postId,
					authorId: "c1",
					authorName: "c",
					body,
				}),
				"pano/CommentValidation",
				"body_required",
			);
		}
	});

	it("rejects bodies over 5 000 chars", async () => {
		const postId = await seedPost({authorId: "p-author-5"});
		await expectFailure(
			addCommentProgram({
				postId,
				authorId: "c1",
				authorName: "c",
				body: "x".repeat(5_001),
			}),
			"pano/CommentValidation",
			"body_too_long",
		);
	});

	it("rejects when target post id doesn't exist with PostNotFound", async () => {
		await expectFailure(
			addCommentProgram({
				postId: "post_does_not_exist_at_all",
				authorId: "c1",
				authorName: "c",
				body: "hello",
			}),
			"pano/PostNotFound",
		);
	});
});
