/**
 * SozlukTerm.voteDefinition / retractDefinitionVote + VoteRecorded
 * projection — task_5.
 *
 * Exercises the producer pattern (ADR 0007) for vote events end-to-end inside
 * workerd:
 *   1. Apply view migrations.
 *   2. Seed a definition via `addDefinition` (T4 path; lands the
 *      `definition_view` row that resolver lookups depend on).
 *   3. Cast a vote → score becomes 1 → `user_vote` row exists →
 *      `user_profile.total_karma` for the author goes 0 → 1.
 *   4. Idempotency: a second vote from the same user is a no-op (score stays
 *      at 1, no duplicate karma bump, no extra outbox events).
 *   5. Retract the vote → score 0 → `user_vote` row gone → karma 1 → 0.
 *   6. Vote → unvote → vote round-trip restores score 1, karma 1, exactly
 *      one `user_vote` row.
 *   7. Outbox durability: a vote that fails workflow.create on the inline
 *      flush leaves the outbox row; `reconcileOutbox` re-queues and clears.
 */
import {env, runInDurableObject} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/view/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/view/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/view/drizzle/migrations/0002_wandering_natasha_romanoff.sql";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [viewMigration0000, viewMigration0001, viewMigration0002];
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
					!msg.includes("no such table")
				) {
					throw err;
				}
			}
		}
	}
}

async function waitForRow<T>(sql: string, params: unknown[], attempts = 30): Promise<T | null> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sql)
			.bind(...params)
			.first();
		if (row) return row as T;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function waitForCondition(
	sql: string,
	params: unknown[],
	predicate: (row: unknown) => boolean,
	attempts = 30,
): Promise<unknown> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sql)
			.bind(...params)
			.first();
		if (row && predicate(row)) return row;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function seedDefinition(slug: string, authorId: string, authorName: string) {
	const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
	const result = await stub.addDefinition({
		authorId,
		authorName,
		body: `seed definition for ${slug}`,
	});
	// Wait for the definition_view projection so the resolver-side lookup
	// resolves the term slug for downstream tests; the Agent path doesn't
	// depend on it but a few of these cases re-read the MV.
	await waitForRow<{id: string}>("SELECT id FROM definition_view WHERE id = ?", [
		result.definitionId,
	]);
	return {stub, definitionId: result.definitionId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("SozlukTerm.voteDefinition — task_5", () => {
	it("casts a vote, recomputes score, projects user_vote + karma", async () => {
		const slug = "vote-cast";
		const authorId = "author-1";
		const voterId = "voter-1";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut");

		const result = await stub.voteDefinition({definitionId, voterId});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);

		// getTerm reflects the new score.
		const term = await stub.getTerm();
		expect(term!.definitions[0]!.score).toBe(1);
		expect(term!.totalScore).toBe(1);

		// user_vote MV row landed via projection.
		const voteRow = await waitForRow<{user_id: string}>(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'definition' AND target_id = ?",
			[voterId, definitionId],
		);
		expect(voteRow).not.toBeNull();

		// user_profile.total_karma bumped to 1 for the author.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[authorId],
			(r) => (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const slug = "vote-idempotent";
		const authorId = "author-idem";
		const voterId = "voter-idem";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut");

		const first = await stub.voteDefinition({definitionId, voterId});
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await stub.voteDefinition({definitionId, voterId});
		expect(second.score).toBe(1);
		expect(second.changed).toBe(false);

		const term = await stub.getTerm();
		expect(term!.definitions[0]!.score).toBe(1);

		// karma stayed at 1 (not 2) — projection didn't double-count.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[authorId],
			(r) => (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();

		// vote table still has exactly one row for this (definition, voter).
		const voteCount = await runInDurableObject(stub, async (instance: any) => {
			const rows = instance.sql<{n: number}>`
				SELECT COUNT(*) as n FROM definition_vote
				WHERE definition_id = ${definitionId} AND voter_id = ${voterId}
			`;
			return rows[0]?.n ?? 0;
		});
		expect(voteCount).toBe(1);
	});

	it("retractDefinitionVote removes the row, recomputes score, projects deletion", async () => {
		const slug = "vote-retract";
		const authorId = "author-retract";
		const voterId = "voter-retract";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut");

		await stub.voteDefinition({definitionId, voterId});
		await waitForRow<{user_id: string}>(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'definition' AND target_id = ?",
			[voterId, definitionId],
		);

		const retract = await stub.retractDefinitionVote({definitionId, voterId});
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);

		const term = await stub.getTerm();
		expect(term!.definitions[0]!.score).toBe(0);

		// user_vote row removed.
		const removed = await waitForCondition(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
			[voterId, definitionId],
			(r) => (r as {n: number}).n === 0,
		);
		expect(removed).not.toBeNull();

		// karma decremented.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[authorId],
			(r) => (r as {total_karma: number}).total_karma === 0,
		);
		expect(profile).not.toBeNull();
	});

	it("retracting a vote that doesn't exist is a no-op", async () => {
		const slug = "vote-noop";
		const authorId = "author-noop";
		const voterId = "voter-noop";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut");

		const result = await stub.retractDefinitionVote({definitionId, voterId});
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
	});

	it("vote → unvote → vote round-trip ends with score 1 and one user_vote row", async () => {
		const slug = "vote-roundtrip";
		const authorId = "author-rt";
		const voterId = "voter-rt";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut");

		await stub.voteDefinition({definitionId, voterId});
		await stub.retractDefinitionVote({definitionId, voterId});
		const final = await stub.voteDefinition({definitionId, voterId});
		expect(final.score).toBe(1);

		// user_vote has exactly one row.
		const voteRow = await waitForCondition(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
			[voterId, definitionId],
			(r) => (r as {n: number}).n === 1,
		);
		expect(voteRow).not.toBeNull();

		// karma at 1.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[authorId],
			(r) => (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();
	});

	it("workflow.create failure on vote leaves outbox rows; reconcileOutbox re-queues and clears", async () => {
		const slug = "vote-reconcile";
		const authorId = "author-reconcile";
		const voterId = "voter-reconcile";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut");

		const counts = await runInDurableObject(stub, async (instance: any) => {
			const original = instance.env.PHOENIX_PROJECTION.create.bind(instance.env.PHOENIX_PROJECTION);
			let calls = 0;
			instance.env.PHOENIX_PROJECTION = {
				...instance.env.PHOENIX_PROJECTION,
				create: async (params: unknown) => {
					calls++;
					// Fail the first two create calls (one TermChanged + one
					// VoteRecorded for the cast). Subsequent reconcile retries
					// hit the original.
					if (calls <= 2) throw new Error("simulated workflow create failure");
					return original(params);
				},
			};

			try {
				await instance.voteDefinition({definitionId, voterId});
			} catch {
				/* swallow */
			}

			const before = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;

			await instance.reconcileOutbox();

			const after = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			return {beforeCount: before.length, afterCount: after.length};
		});

		// Two events queued (TermChanged + VoteRecorded), both stuck initially.
		expect(counts.beforeCount).toBe(2);
		expect(counts.afterCount).toBe(0);
	});

	it("voteDefinition for an unknown definitionId rejects with DefinitionNotFoundError", async () => {
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName("vote-not-found"));
		// Seed so the term exists but use a fabricated definition id.
		await stub.addDefinition({
			authorId: "author-x",
			authorName: "x",
			body: "anchor definition",
		});
		try {
			await stub.voteDefinition({definitionId: "def_NEVER", voterId: "voter-x"});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/not found/i);
		}
	});
});
