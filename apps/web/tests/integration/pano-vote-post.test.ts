/**
 * `Pano.voteOnPost` / `Pano.retractPostVote` — Effect service surface
 * (effect-migration task 5).
 *
 * Vote logic now delegates to `Vote.cast`; pano translates the typed
 * `VoteTargetNotFound` failure into `PostNotFound` so the resolver codec
 * keeps producing `POST_NOT_FOUND` on a race.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
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

function voteOnPost(input: VoteOnPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.voteOnPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function retractPostVote(input: VoteOnPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.retractPostVote(input);
		}).pipe(Effect.provide(TestLive)),
	);
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

/**
 * Seed an empty `user_profile` row so `karmaBumpStatement` (a plain UPDATE,
 * by design) lands on an existing row. Mirrors the helper in
 * `vote-service.test.ts` / `sozluk-vote-definition.test.ts`.
 */
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

async function seedPost(authorId: string, authorName = "umut") {
	await seedProfile(authorId);
	const result = await submitPost({
		title: `seed post ${Math.random().toString(36).slice(2)}`,
		tags: [{kind: "tartışma"}],
		authorId,
		authorName,
	});
	return {postId: result.postId};
}

async function expectFailureTag(
	program: Effect.Effect<unknown, unknown, never>,
	tag: string,
): Promise<void> {
	const exit = await Effect.runPromise(Effect.exit(program));
	if (Exit.isSuccess(exit)) throw new Error("expected failure");
	const found = Cause.findError(exit.cause);
	if (found._tag !== "Success") throw new Error("expected typed failure");
	const err = found.success as {_tag?: string};
	expect(err._tag).toBe(tag);
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("Pano.voteOnPost", () => {
	it("casts a vote, recomputes score + hot_score, projects user_vote + karma", async () => {
		const authorId = "author-vote-1";
		const voterId = "voter-vote-1";
		const {postId} = await seedPost(authorId);

		const result = await voteOnPost({postId, voterId});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);
		expect(result.hotScore).toBeGreaterThan(0);

		const summary = (await env.PHOENIX_DB.prepare(
			"SELECT score, hot_score FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first()) as {score: number; hot_score: number} | null;
		expect(summary).not.toBeNull();
		expect(summary!.score).toBe(1);
		expect(summary!.hot_score).toBeGreaterThan(0);

		const voteRow = await env.PHOENIX_DB.prepare(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?",
		)
			.bind(voterId, postId)
			.first();
		expect(voteRow).not.toBeNull();

		const profile = (await env.PHOENIX_DB.prepare(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {user_id: string; total_karma: number} | null;
		expect(profile).not.toBeNull();
		expect(profile!.total_karma).toBe(1);
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const authorId = "author-idem";
		const voterId = "voter-idem";
		const {postId} = await seedPost(authorId);

		const first = await voteOnPost({postId, voterId});
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await voteOnPost({postId, voterId});
		expect(second.score).toBe(1);
		expect(second.changed).toBe(false);

		const profile = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(profile!.total_karma).toBe(1);

		const voteCount = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM post_vote WHERE post_id = ? AND voter_id = ?",
		)
			.bind(postId, voterId)
			.first()) as {n: number} | null;
		expect(voteCount!.n).toBe(1);
	});

	it("retractPostVote removes the row, recomputes score, projects deletion", async () => {
		const authorId = "author-retract";
		const voterId = "voter-retract";
		const {postId} = await seedPost(authorId);

		await voteOnPost({postId, voterId});

		const retract = await retractPostVote({postId, voterId});
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);
		expect(retract.myVote).toBeNull();

		const voteCount = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, postId)
			.first()) as {n: number} | null;
		expect(voteCount!.n).toBe(0);

		const profile = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting a vote that doesn't exist is a no-op", async () => {
		const authorId = "author-noop";
		const voterId = "voter-noop";
		const {postId} = await seedPost(authorId);

		const result = await retractPostVote({postId, voterId});
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
	});

	it("vote → unvote → vote round-trip ends with score 1 and one user_vote row", async () => {
		const authorId = "author-rt";
		const voterId = "voter-rt";
		const {postId} = await seedPost(authorId);

		await voteOnPost({postId, voterId});
		await retractPostVote({postId, voterId});
		const final = await voteOnPost({postId, voterId});
		expect(final.score).toBe(1);

		const voteRow = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, postId)
			.first()) as {n: number} | null;
		expect(voteRow!.n).toBe(1);

		const profile = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(profile!.total_karma).toBe(1);
	});

	it("voteOnPost on an unknown post id rejects with PostNotFound", async () => {
		await expectFailureTag(
			Effect.gen(function* () {
				const pano = yield* Pano;
				return yield* pano.voteOnPost({postId: "post_DOES_NOT_EXIST", voterId: "voter-x"});
			}).pipe(Effect.provide(TestLive)),
			"pano/PostNotFound",
		);
	});
});
