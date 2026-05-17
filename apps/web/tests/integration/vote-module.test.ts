/**
 * Vote module integration tests (task_10, d1-direct).
 *
 * Exercises the canonical `vote()` entry point at
 * `worker/features/vote/module.ts`. The module discriminates writes by
 * `targetKind: 'definition' | 'post' | 'comment'` and atomically updates:
 *   - the feature-local vote table (`definition_vote`, `post_vote`,
 *     `comment_vote`) — score truth source.
 *   - the cross-product `user_vote` table (PK `(userId, targetKind,
 *     targetId)`) — powers `myVote`.
 *   - the target row's score / counter cache (`definition_view.score`, etc).
 *   - the target author's `user_profile.total_karma`.
 *
 * Idempotency is exercised against the `user_vote` PK + the feature-local
 * vote-table PK: re-casting the same value is a no-op; retracting when
 * nothing is set is a no-op; flipping (cast → retract → cast) round-trips
 * to a single row.
 *
 * Only `targetKind: 'definition'` is covered here — task_11 lifts pano's
 * post/comment vote paths onto this module and adds its own coverage.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/db/drizzle/migrations/0003_lazy_thanos.sql";
import viewMigration0004 from "../../worker/db/drizzle/migrations/0004_brown_squadron_supreme.sql";
import viewMigration0005 from "../../worker/db/drizzle/migrations/0005_d1_direct_sozluk.sql";
import {addDefinition} from "../../worker/features/sozluk/module";
import {vote, VoteTargetNotFoundError} from "../../worker/features/vote/module";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [
		viewMigration0000,
		viewMigration0001,
		viewMigration0002,
		viewMigration0003,
		viewMigration0004,
		viewMigration0005,
	];
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

async function seedDefinition(slug: string, authorId: string) {
	const result = await addDefinition(env, {
		termSlug: slug,
			authorId,
		authorName: "umut",
		body: `seed for ${slug}`,
	});
	return result.definitionId;
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("vote module — task_10 (d1-direct)", () => {
	it("casts a definition vote: score 0 → 1, user_vote row written, karma bumped", async () => {
		const definitionId = await seedDefinition("vote-mod-cast", "author-cast");

		const result = await vote(env, {
			userId: "voter-cast",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);

		const def = await env.PHOENIX_DB.prepare(
			"SELECT score FROM definition_view WHERE id = ?",
		)
			.bind(definitionId)
			.first<{score: number}>();
		expect(def!.score).toBe(1);

		// user_vote PK row present.
		const uv = await env.PHOENIX_DB.prepare(
			"SELECT 1 as ok FROM user_vote WHERE user_id = ? AND target_kind = ? AND target_id = ?",
		)
			.bind("voter-cast", "definition", definitionId)
			.first();
		expect(uv).not.toBeNull();

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind("author-cast")
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("re-casting the same value is an idempotent no-op", async () => {
		const definitionId = await seedDefinition("vote-mod-recast", "author-recast");

		const first = await vote(env, {
			userId: "voter-recast",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(first.changed).toBe(true);
		expect(first.score).toBe(1);

		const second = await vote(env, {
			userId: "voter-recast",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(second.changed).toBe(false);
		expect(second.score).toBe(1);
		expect(second.myVote).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ? AND voter_id = ?",
		)
			.bind(definitionId, "voter-recast")
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind("author-recast")
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("flips cast → retract: row deleted, score back to 0, karma decremented", async () => {
		const definitionId = await seedDefinition("vote-mod-flip", "author-flip");

		await vote(env, {
			userId: "voter-flip",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});

		const retracted = await vote(env, {
			userId: "voter-flip",
			targetKind: "definition",
			targetId: definitionId,
			value: null,
		});
		expect(retracted.changed).toBe(true);
		expect(retracted.score).toBe(0);
		expect(retracted.myVote).toBe(null);

		const dvCount = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ? AND voter_id = ?",
		)
			.bind(definitionId, "voter-flip")
			.first<{n: number}>();
		expect(dvCount!.n).toBe(0);

		const uvCount = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_kind = 'definition' AND target_id = ?",
		)
			.bind("voter-flip", definitionId)
			.first<{n: number}>();
		expect(uvCount!.n).toBe(0);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind("author-flip")
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting when no vote exists is a no-op", async () => {
		const definitionId = await seedDefinition("vote-mod-retract-noop", "author-rnoop");

		const result = await vote(env, {
			userId: "voter-rnoop",
			targetKind: "definition",
			targetId: definitionId,
			value: null,
		});
		expect(result.changed).toBe(false);
		expect(result.score).toBe(0);
		expect(result.myVote).toBe(null);
	});

	it("cast → retract → cast round-trip ends at score 1, one row, karma 1", async () => {
		const definitionId = await seedDefinition("vote-mod-rt", "author-rt");

		await vote(env, {
			userId: "voter-rt",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		await vote(env, {
			userId: "voter-rt",
			targetKind: "definition",
			targetId: definitionId,
			value: null,
		});
		const final = await vote(env, {
			userId: "voter-rt",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(final.score).toBe(1);
		expect(final.myVote).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ?",
		)
			.bind(definitionId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind("author-rt")
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("voting on an unknown definition rejects with VoteTargetNotFoundError", async () => {
		await expect(
			vote(env, {
				userId: "voter-x",
				targetKind: "definition",
				targetId: "def_NEVER_EXISTS",
				value: 1,
			}),
		).rejects.toBeInstanceOf(VoteTargetNotFoundError);
	});
});
