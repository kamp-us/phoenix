/**
 * Sozluk `voteDefinition` / `retractDefinitionVote` — Effect service path
 * (effect-migration task 4).
 *
 * Exercises the service surface against `env.PHOENIX_DB`:
 *   1. Cast a vote → score 0 → 1; `definition_vote` row exists;
 *      `user_vote` row exists; `user_profile.total_karma` 0 → 1.
 *   2. Idempotency: a second cast from the same voter is a no-op
 *      (score stays 1, karma stays 1, exactly one `definition_vote` row).
 *   3. Retract → score 0; row gone from both `definition_vote` and
 *      `user_vote`; karma 1 → 0.
 *   4. Retract when no vote exists is a no-op.
 *   5. Vote → unvote → vote round-trip ends with score 1 and one row.
 *   6. Vote on an unknown definitionId fails with `sozluk/DefinitionNotFound`.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {Sozluk, SozlukLive} from "../../worker/features/sozluk/Sozluk";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = SozlukLive.pipe(
	Layer.provideMerge(VoteLive),
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

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

const runSozluk = <A, E>(eff: Effect.Effect<A, E, Sozluk>) =>
	Effect.runPromise(eff.pipe(Effect.provide(TestLive)) as Effect.Effect<A, E, never>);

/**
 * Seed an empty `user_profile` row so `karmaBumpStatement` (a plain UPDATE,
 * by design) lands on an existing row. The new `Vote` service composes the
 * pure karma statement from `pasaport/karma.ts` and trusts profiles already
 * exist (the production write path goes through `Pasaport.setUsername` →
 * `user_profile` upsert before any vote can be cast).
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

async function seedDefinition(slug: string, authorId: string, authorName: string) {
	await seedProfile(authorId);
	const result = await runSozluk(
		Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			return yield* sozluk.addDefinition({
				termSlug: slug,
				authorId,
				authorName,
				body: `seed definition for ${slug}`,
			});
		}),
	);
	return {definitionId: result.definitionId};
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

describe("sozluk.voteDefinition", () => {
	it("casts a vote, recomputes score, writes user_vote + karma inline", async () => {
		const slug = "vote-cast";
		const authorId = "author-1";
		const voterId = "voter-1";
		const {definitionId} = await seedDefinition(slug, authorId, "umut");

		const result = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.voteDefinition({definitionId, voterId});
			}),
		);
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);

		// definition_view.score reflects the new value.
		const def = await env.PHOENIX_DB.prepare("SELECT score FROM definition_view WHERE id = ?")
			.bind(definitionId)
			.first<{score: number}>();
		expect(def!.score).toBe(1);

		// term_summary recomputed.
		const summary = await env.PHOENIX_DB.prepare(
			"SELECT total_score, definition_count FROM term_summary WHERE slug = ?",
		)
			.bind(slug)
			.first<{total_score: number; definition_count: number}>();
		expect(summary!.total_score).toBe(1);

		// user_vote row exists.
		const vote = await env.PHOENIX_DB.prepare(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'definition' AND target_id = ?",
		)
			.bind(voterId, definitionId)
			.first();
		expect(vote).not.toBeNull();

		// user_profile karma bumped.
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const slug = "vote-idempotent";
		const authorId = "author-idem";
		const voterId = "voter-idem";
		const {definitionId} = await seedDefinition(slug, authorId, "umut");

		const first = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.voteDefinition({definitionId, voterId});
			}),
		);
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.voteDefinition({definitionId, voterId});
			}),
		);
		expect(second.score).toBe(1);
		expect(second.changed).toBe(false);
		expect(second.myVote).toBe(1);

		// karma stayed at 1.
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);

		// Exactly one definition_vote row.
		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ? AND voter_id = ?",
		)
			.bind(definitionId, voterId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);
	});

	it("retractDefinitionVote removes the row, recomputes score, decrements karma", async () => {
		const slug = "vote-retract";
		const authorId = "author-retract";
		const voterId = "voter-retract";
		const {definitionId} = await seedDefinition(slug, authorId, "umut");

		await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.voteDefinition({definitionId, voterId});
			}),
		);

		const retract = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.retractDefinitionVote({definitionId, voterId});
			}),
		);
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);
		expect(retract.myVote).toBe(null);

		const def = await env.PHOENIX_DB.prepare("SELECT score FROM definition_view WHERE id = ?")
			.bind(definitionId)
			.first<{score: number}>();
		expect(def!.score).toBe(0);

		// user_vote row removed.
		const vote = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, definitionId)
			.first<{n: number}>();
		expect(vote!.n).toBe(0);

		// karma decremented.
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting a vote that doesn't exist is a no-op", async () => {
		const slug = "vote-noop";
		const authorId = "author-noop";
		const voterId = "voter-noop";
		const {definitionId} = await seedDefinition(slug, authorId, "umut");

		const result = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.retractDefinitionVote({definitionId, voterId});
			}),
		);
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
		expect(result.myVote).toBe(null);
	});

	it("vote → unvote → vote round-trip ends with score 1 and one definition_vote row", async () => {
		const slug = "vote-roundtrip";
		const authorId = "author-rt";
		const voterId = "voter-rt";
		const {definitionId} = await seedDefinition(slug, authorId, "umut");

		await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.voteDefinition({definitionId, voterId});
			}),
		);
		await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.retractDefinitionVote({definitionId, voterId});
			}),
		);
		const final = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.voteDefinition({definitionId, voterId});
			}),
		);
		expect(final.score).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ? AND voter_id = ?",
		)
			.bind(definitionId, voterId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("voteDefinition on an unknown definitionId fails with DefinitionNotFound", async () => {
		await expectFailureTag(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.voteDefinition({definitionId: "def_NEVER", voterId: "voter-x"});
			}).pipe(Effect.provide(TestLive)),
			"sozluk/DefinitionNotFound",
		);
	});
});
