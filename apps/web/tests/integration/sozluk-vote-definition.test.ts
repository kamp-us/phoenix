/**
 * Sozluk D1-direct `voteDefinition` / `retractDefinitionVote`.
 *
 * Exercises the module-functional path against `env.PHOENIX_DB`:
 *   1. Cast a vote → score 0 → 1; `definition_vote` row exists;
 *      `user_vote` row exists; `user_profile.total_karma` 0 → 1.
 *   2. Idempotency: a second cast from the same voter is a no-op
 *      (score stays 1, karma stays 1, exactly one `definition_vote` row).
 *   3. Retract → score 0; row gone from both `definition_vote` and
 *      `user_vote`; karma 1 → 0.
 *   4. Retract when no vote exists is a no-op.
 *   5. Vote → unvote → vote round-trip ends with score 1 and one row.
 *   6. Vote on an unknown definitionId rejects with DefinitionNotFoundError.
 *
 * No `runInDurableObject`, no outbox, no projection workflow.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	addDefinition,
	DefinitionNotFoundError,
	retractDefinitionVote,
	voteDefinition,
} from "../../worker/features/sozluk/module";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
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

async function seedDefinition(slug: string, authorId: string, authorName: string) {
	const result = await addDefinition(env, {
		termSlug: slug,
		authorId,
		authorName,
		body: `seed definition for ${slug}`,
	});
	return {definitionId: result.definitionId};
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

		const result = await voteDefinition(env, {definitionId, voterId});
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

		const first = await voteDefinition(env, {definitionId, voterId});
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await voteDefinition(env, {definitionId, voterId});
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

		await voteDefinition(env, {definitionId, voterId});

		const retract = await retractDefinitionVote(env, {definitionId, voterId});
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

		const result = await retractDefinitionVote(env, {definitionId, voterId});
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
		expect(result.myVote).toBe(null);
	});

	it("vote → unvote → vote round-trip ends with score 1 and one definition_vote row", async () => {
		const slug = "vote-roundtrip";
		const authorId = "author-rt";
		const voterId = "voter-rt";
		const {definitionId} = await seedDefinition(slug, authorId, "umut");

		await voteDefinition(env, {definitionId, voterId});
		await retractDefinitionVote(env, {definitionId, voterId});
		const final = await voteDefinition(env, {definitionId, voterId});
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

	it("voteDefinition on an unknown definitionId rejects with DefinitionNotFoundError", async () => {
		await expect(
			voteDefinition(env, {definitionId: "def_NEVER", voterId: "voter-x"}),
		).rejects.toBeInstanceOf(DefinitionNotFoundError);
	});
});
