/**
 * `Pano.editPost` / `Pano.deletePost` — Effect service surface
 * (effect-migration task 5).
 *
 * Atomicity is now enforced by `Drizzle.batch(...)`; the spy-env-style tests
 * from the legacy module surface no longer apply (the drizzle builder is
 * constructed at layer build, so an `env` Proxy injected post-layer can't
 * intercept its statements). The behavioral guarantees — fully-removed
 * post_summary, dropped post_vote / user_vote, karma decremented — remain
 * fully covered by the assertions below.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	type DeletePostInput,
	type EditPostInput,
	Pano,
	PanoLive,
	type SubmitPostInput,
	type VoteOnPostInput,
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

function editPost(input: EditPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.editPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function deletePost(input: DeletePostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.deletePost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function voteOnPost(input: VoteOnPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.voteOnPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function editPostProgram(input: EditPostInput) {
	return Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.editPost(input);
	}).pipe(Effect.provide(TestLive));
}

function deletePostProgram(input: DeletePostInput) {
	return Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.deletePost(input);
	}).pipe(Effect.provide(TestLive));
}

async function expectFailure(
	program: Effect.Effect<unknown, unknown, never>,
	tag: string,
	code?: string,
): Promise<void> {
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

async function seedProfile(userId: string) {
	const now = Math.floor(Date.now() / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO user_profile (
			user_id, username, display_name, image,
			total_karma, definition_count, post_count, comment_count,
			updated_at, last_event_id
		) VALUES (?, NULL, NULL, NULL, 0, 0, 0, 0, ?, '')
		ON CONFLICT(user_id) DO NOTHING`,
	)
		.bind(userId, now)
		.run();
}

async function seedPost(opts: {
	authorId: string;
	authorName?: string;
	title?: string;
	body?: string;
}) {
	await seedProfile(opts.authorId);
	const result = await submitPost({
		title: opts.title ?? "original title",
		body: opts.body ?? "original body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "umut",
	});
	return {postId: result.postId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("Pano.editPost", () => {
	it("updates title + body inline on post_summary (body + body_excerpt + updated_at)", async () => {
		const authorId = "edit-post-author";
		const {postId} = await seedPost({authorId});

		const before = (await env.PHOENIX_DB.prepare(
			"SELECT title, body, body_excerpt FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first()) as {title: string; body: string; body_excerpt: string};
		expect(before.title).toBe("original title");
		expect(before.body).toBe("original body");

		const result = await editPost({
			postId,
			actorId: authorId,
			title: "edited title — fresh",
			body: "edited body — significantly different content here.",
		});
		expect(result.title).toBe("edited title — fresh");
		expect(result.body).toContain("edited body");
		expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(result.createdAt.getTime());

		const after = (await env.PHOENIX_DB.prepare(
			"SELECT title, body, body_excerpt FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first()) as {title: string; body: string; body_excerpt: string};
		expect(after.title).toBe("edited title — fresh");
		expect(after.body).toContain("edited body");
		expect(after.body_excerpt).toContain("edited body");
	});

	it("allows editing title alone", async () => {
		const authorId = "edit-title-only";
		const {postId} = await seedPost({authorId});

		await editPost({postId, actorId: authorId, title: "title-only edit"});

		const row = (await env.PHOENIX_DB.prepare("SELECT title, body FROM post_summary WHERE id = ?")
			.bind(postId)
			.first()) as {title: string; body: string};
		expect(row.title).toBe("title-only edit");
		expect(row.body).toBe("original body");
	});

	it("allows editing body alone", async () => {
		const authorId = "edit-body-only";
		const {postId} = await seedPost({authorId});

		await editPost({postId, actorId: authorId, body: "body-only edit"});

		const row = (await env.PHOENIX_DB.prepare("SELECT title, body FROM post_summary WHERE id = ?")
			.bind(postId)
			.first()) as {title: string; body: string};
		expect(row.title).toBe("original title");
		expect(row.body).toBe("body-only edit");
	});

	it("rejects when neither title nor body provided", async () => {
		const authorId = "edit-empty";
		const {postId} = await seedPost({authorId});
		await expectFailure(
			editPostProgram({postId, actorId: authorId}),
			"pano/PostValidation",
			"title_required",
		);
	});

	it("rejects empty title (trim)", async () => {
		const authorId = "edit-blank-title";
		const {postId} = await seedPost({authorId});
		await expectFailure(
			editPostProgram({postId, actorId: authorId, title: "   "}),
			"pano/PostValidation",
			"title_required",
		);
	});

	it("rejects titles over 200 chars", async () => {
		const authorId = "edit-title-long";
		const {postId} = await seedPost({authorId});
		await expectFailure(
			editPostProgram({postId, actorId: authorId, title: "x".repeat(201)}),
			"pano/PostValidation",
			"title_too_long",
		);
	});

	it("rejects bodies over 10 000 chars", async () => {
		const authorId = "edit-body-long";
		const {postId} = await seedPost({authorId});
		await expectFailure(
			editPostProgram({postId, actorId: authorId, body: "x".repeat(10_001)}),
			"pano/PostValidation",
			"body_too_long",
		);
	});

	it("ownership: non-author edit is rejected with UnauthorizedPostMutation", async () => {
		const authorId = "owner-post";
		const otherId = "intruder-post";
		const {postId} = await seedPost({authorId, title: "owner's title"});

		await expectFailure(
			editPostProgram({postId, actorId: otherId, title: "intruder's title rewrite"}),
			"pano/UnauthorizedPostMutation",
		);

		const row = (await env.PHOENIX_DB.prepare("SELECT title FROM post_summary WHERE id = ?")
			.bind(postId)
			.first()) as {title: string};
		expect(row.title).toBe("owner's title");
	});
});

describe("Pano.deletePost", () => {
	it("fully removes the row from post_summary (matches legacy PostDeleted semantics)", async () => {
		const authorId = "delete-post-author";
		const {postId} = await seedPost({authorId});

		const before = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(before).not.toBeNull();

		const result = await deletePost({postId, actorId: authorId});
		expect(result.deleted).toBe(true);

		const after = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(after).toBeNull();
	});

	it("ownership: non-author delete is rejected with UnauthorizedPostMutation", async () => {
		const authorId = "owner-del";
		const otherId = "intruder-del";
		const {postId} = await seedPost({authorId});

		await expectFailure(
			deletePostProgram({postId, actorId: otherId}),
			"pano/UnauthorizedPostMutation",
		);

		const row = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(row).not.toBeNull();
	});

	it("re-deleting an already-deleted post is an idempotent no-op", async () => {
		const authorId = "delete-idem";
		const {postId} = await seedPost({authorId});

		const first = await deletePost({postId, actorId: authorId});
		expect(first.deleted).toBe(true);

		const second = await deletePost({postId, actorId: authorId});
		expect(second.deleted).toBe(false);
	});

	it("decrements pano_stats.total_posts on delete", async () => {
		const authorId = "delete-stats";
		const {postId} = await seedPost({authorId});

		const beforeStats = (await env.PHOENIX_DB.prepare(
			"SELECT total_posts FROM pano_stats WHERE id = 1",
		).first()) as {total_posts: number} | null;
		const beforeCount = beforeStats?.total_posts ?? 0;
		expect(beforeCount).toBeGreaterThanOrEqual(1);

		await deletePost({postId, actorId: authorId});

		const afterStats = (await env.PHOENIX_DB.prepare(
			"SELECT total_posts FROM pano_stats WHERE id = 1",
		).first()) as {total_posts: number} | null;
		expect(afterStats!.total_posts).toBe(beforeCount - 1);

		const row = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(row).toBeNull();
	});

	it("drops post_vote + user_vote mirror rows and decrements karma by the prior score", async () => {
		const authorId = "delete-with-votes-author";
		const voterId = "delete-with-votes-voter";
		const {postId} = await seedPost({authorId});

		await voteOnPost({postId, voterId});

		const karmaBefore = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(karmaBefore!.total_karma).toBe(1);

		await deletePost({postId, actorId: authorId});

		const postVotes = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM post_vote WHERE post_id = ?",
		)
			.bind(postId)
			.first()) as {n: number} | null;
		expect(postVotes!.n).toBe(0);

		const userVotes = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE target_kind = 'post' AND target_id = ?",
		)
			.bind(postId)
			.first()) as {n: number} | null;
		expect(userVotes!.n).toBe(0);

		const karmaAfter = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(karmaAfter!.total_karma).toBe(0);
	});
});
