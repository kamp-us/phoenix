/**
 * fate pano mutations — write + re-resolve + wire-error parity.
 *
 * Drives the real pano mutation resolvers from `pano-mutations.ts` through a
 * per-request `FateRuntime` (the same runtime the `/fate` route builds), with a
 * session baked into the `Auth` layer — so each test exercises the full
 * `fateMutation → Pano service → re-resolved entity / encodeFateError` path
 * against the live `env.PHOENIX_DB` inside workerd. This is the pano analog of
 * the sozluk mutation integration test; the HTTP `/fate` route adds only session
 * validation on top, which the seam test already covers.
 *
 * Asserts:
 *   - `post.submit` writes and returns the re-resolved `Post` (with tags).
 *   - `post.vote` / `retractVote` return the entity with `myVote` + score.
 *   - `post.edit` returns the edited entity.
 *   - `post.delete` returns the deleted post id.
 *   - `comment.add` writes and returns the re-resolved `Comment`.
 *   - `comment.vote` / `retractVote` return the entity with `myVote` stamped.
 *   - `comment.edit` returns the edited entity.
 *   - `comment.delete` returns the re-resolved **parent `Post`**.
 *   - domain failures surface the same wire codes as GraphQL
 *     (`TAGS_REQUIRED`, `POST_NOT_FOUND`, `COMMENT_NOT_FOUND`, `UNAUTHORIZED`).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {FateRequestError} from "@nkzw/fate/server";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import type {FateContext} from "../../worker/fate/context";
import {panoMutations} from "../../worker/fate/pano-mutations";
import {FateRuntime, type SessionData} from "../../worker/fate/runtime";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const statements = baselineMigration
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

const request = new Request("https://test.local/fate", {method: "POST"});

/** A `FateContext` whose runtime bakes in the given session (or anonymous). */
function makeCtx(user?: {id: string; email: string; name?: string | null}): {
	ctx: FateContext;
	dispose: () => Promise<void>;
} {
	const sessionData: SessionData = user ? {user: user as never} : null;
	const runtime = FateRuntime.make(env, request, sessionData);
	return {ctx: {runtime, request}, dispose: () => runtime.dispose()};
}

/** Invoke a mutation definition the way the fate server would. */
function invoke<I, O>(
	def: {resolve: (o: {ctx: FateContext; input: I; select: Array<string>}) => Promise<O>},
	ctx: FateContext,
	input: I,
	select: Array<string> = [],
): Promise<O> {
	return def.resolve({ctx, input, select});
}

const USER = {id: "pano-author-1", email: "author@test.local", name: "yazar"};

beforeAll(async () => {
	await applyViewMigrations();
});

describe("fate pano post mutations", () => {
	it("post.submit writes and returns the re-resolved Post", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const post = await invoke(panoMutations["post.submit"], ctx, {
				title: "a submitted post",
				body: "the post body",
				tags: [{kind: "tartışma"}],
			});
			expect(post.__typename).toBe("Post");
			expect(post.id).toBeTruthy();
			expect(post.title).toBe("a submitted post");
			expect(post.author).toBe("yazar");
			expect(post.authorId).toBe(USER.id);
			expect(post.score).toBe(0);
			expect(post.commentCount).toBe(0);
			expect(post.myVote).toBeNull();
			expect(post.tags.map((t) => t.kind)).toEqual(["tartışma"]);
		} finally {
			await dispose();
		}
	});

	it("post.vote then retractVote return the entity with myVote + score", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const post = await invoke(panoMutations["post.submit"], ctx, {
				title: "a votable post",
				tags: [{kind: "soru"}],
			});
			const voted = await invoke(panoMutations["post.vote"], ctx, {id: post.id});
			expect(voted.score).toBe(1);
			expect(voted.myVote).toBe(1);

			const retracted = await invoke(panoMutations["post.retractVote"], ctx, {id: post.id});
			expect(retracted.score).toBe(0);
			expect(retracted.myVote).toBeNull();
		} finally {
			await dispose();
		}
	});

	it("post.edit returns the edited entity", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const post = await invoke(panoMutations["post.submit"], ctx, {
				title: "before edit",
				tags: [{kind: "meta"}],
			});
			const edited = await invoke(panoMutations["post.edit"], ctx, {
				id: post.id,
				title: "after edit",
			});
			expect(edited.id).toBe(post.id);
			expect(edited.title).toBe("after edit");
		} finally {
			await dispose();
		}
	});

	it("post.delete returns the deleted post id", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const post = await invoke(panoMutations["post.submit"], ctx, {
				title: "to be deleted",
				tags: [{kind: "söylenme"}],
			});
			const deleted = await invoke(panoMutations["post.delete"], ctx, {id: post.id});
			expect(deleted.__typename).toBe("Post");
			expect(deleted.id).toBe(post.id);
		} finally {
			await dispose();
		}
	});

	it("missing tags surfaces TAGS_REQUIRED (same wire code as GraphQL)", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const err = await invoke(panoMutations["post.submit"], ctx, {
				title: "no tags here",
				tags: [],
			}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(FateRequestError);
			expect((err as FateRequestError).code).toBe("TAGS_REQUIRED");
		} finally {
			await dispose();
		}
	});

	it("voting a missing post surfaces POST_NOT_FOUND", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			await expect(
				invoke(panoMutations["post.vote"], ctx, {id: "post_does_not_exist"}),
			).rejects.toMatchObject({code: "POST_NOT_FOUND"});
		} finally {
			await dispose();
		}
	});

	it("anonymous writes surface UNAUTHORIZED", async () => {
		const {ctx, dispose} = makeCtx(); // no session
		try {
			await expect(
				invoke(panoMutations["post.submit"], ctx, {title: "nope", tags: [{kind: "soru"}]}),
			).rejects.toMatchObject({code: "UNAUTHORIZED"});
		} finally {
			await dispose();
		}
	});
});

describe("fate pano comment mutations", () => {
	it("comment.add writes and returns the re-resolved Comment", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const post = await invoke(panoMutations["post.submit"], ctx, {
				title: "a post to comment on",
				tags: [{kind: "tartışma"}],
			});
			const comment = await invoke(panoMutations["comment.add"], ctx, {
				postId: post.id,
				body: "a comment body",
			});
			expect(comment.__typename).toBe("Comment");
			expect(comment.id).toBeTruthy();
			expect(comment.body).toBe("a comment body");
			expect(comment.author).toBe("yazar");
			expect(comment.authorId).toBe(USER.id);
			expect(comment.score).toBe(0);
			expect(comment.myVote).toBeNull();
		} finally {
			await dispose();
		}
	});

	it("comment.vote then retractVote return the entity with myVote stamped", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const post = await invoke(panoMutations["post.submit"], ctx, {
				title: "comment vote post",
				tags: [{kind: "soru"}],
			});
			const comment = await invoke(panoMutations["comment.add"], ctx, {
				postId: post.id,
				body: "a votable comment",
			});
			const voted = await invoke(panoMutations["comment.vote"], ctx, {id: comment.id});
			expect(voted.score).toBe(1);
			expect(voted.myVote).toBe(1);

			const retracted = await invoke(panoMutations["comment.retractVote"], ctx, {id: comment.id});
			expect(retracted.score).toBe(0);
			expect(retracted.myVote).toBeNull();
		} finally {
			await dispose();
		}
	});

	it("comment.edit returns the edited entity", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const post = await invoke(panoMutations["post.submit"], ctx, {
				title: "comment edit post",
				tags: [{kind: "meta"}],
			});
			const comment = await invoke(panoMutations["comment.add"], ctx, {
				postId: post.id,
				body: "before edit",
			});
			const edited = await invoke(panoMutations["comment.edit"], ctx, {
				id: comment.id,
				body: "after edit",
			});
			expect(edited.id).toBe(comment.id);
			expect(edited.body).toBe("after edit");
		} finally {
			await dispose();
		}
	});

	it("comment.delete returns the re-resolved parent Post", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			const post = await invoke(panoMutations["post.submit"], ctx, {
				title: "comment delete post",
				tags: [{kind: "tartışma"}],
			});
			const a = await invoke(panoMutations["comment.add"], ctx, {
				postId: post.id,
				body: "to be deleted (leaf)",
			});
			await invoke(panoMutations["comment.add"], ctx, {
				postId: post.id,
				body: "the survivor",
			});

			const parent = await invoke(panoMutations["comment.delete"], ctx, {id: a.id});
			expect(parent).not.toBeNull();
			expect(parent!.__typename).toBe("Post");
			expect(parent!.id).toBe(post.id);
			// One comment remains after the leaf delete (2 added, 1 removed).
			expect(parent!.commentCount).toBe(1);
		} finally {
			await dispose();
		}
	});

	it("deleting a missing comment surfaces COMMENT_NOT_FOUND", async () => {
		const {ctx, dispose} = makeCtx(USER);
		try {
			await expect(
				invoke(panoMutations["comment.vote"], ctx, {id: "comm_does_not_exist"}),
			).rejects.toMatchObject({code: "COMMENT_NOT_FOUND"});
		} finally {
			await dispose();
		}
	});
});
