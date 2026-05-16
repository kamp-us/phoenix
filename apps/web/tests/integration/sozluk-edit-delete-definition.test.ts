/**
 * SozlukTerm.editDefinition / deleteDefinition + DefinitionEdited /
 * DefinitionDeleted projection — task_6.
 *
 * Exercises the producer pattern (ADR 0007) end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Seed a definition via `addDefinition` (T4 path).
 *   3. Edit the body → updated_at + body_excerpt land on definition_view.
 *   4. Ownership: a non-author actor's edit / delete throws
 *      `UnauthorizedDefinitionMutationError`.
 *   5. Delete → soft-deletes (sets `deleted_at`); `getTerm` filters it out;
 *      term aggregates (`definitionCount`, `totalScore`) decrement; the
 *      `definition_view` row gets `deleted_at` stamped via the projection.
 *   6. Idempotent re-delete on an already-deleted row is a no-op.
 *   7. Outbox durability: an edit / delete that fails workflow.create
 *      leaves the outbox rows; `reconcileOutbox` re-queues and clears.
 */
import {env, runInDurableObject} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";

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

async function seedDefinition(slug: string, authorId: string, authorName: string, body: string) {
	const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
	const result = await stub.addDefinition({authorId, authorName, body});
	await waitForRow<{id: string}>("SELECT id FROM definition_view WHERE id = ?", [
		result.definitionId,
	]);
	return {stub, definitionId: result.definitionId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("SozlukTerm.editDefinition — task_6", () => {
	it("updates body + updatedAt and projects DefinitionEdited onto definition_view", async () => {
		const slug = "edit-happy";
		const authorId = "edit-author";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut", "original body");

		const before = await waitForRow<{body_excerpt: string}>(
			"SELECT body_excerpt FROM definition_view WHERE id = ?",
			[definitionId],
		);
		expect(before!.body_excerpt).toContain("original body");

		const result = await stub.editDefinition({
			definitionId,
			actorId: authorId,
			body: "edited body — significantly different content here.",
		});
		expect(result.body).toContain("edited body");

		// getTerm reflects the new body.
		const term = await stub.getTerm();
		expect(term!.definitions[0]!.body).toContain("edited body");

		// definition_view's body_excerpt refreshed via projection.
		const after = await waitForCondition(
			"SELECT body_excerpt FROM definition_view WHERE id = ?",
			[definitionId],
			(r) => (r as {body_excerpt: string}).body_excerpt.includes("edited body"),
		);
		expect(after).not.toBeNull();
	});

	it("rejects edits with empty body", async () => {
		const slug = "edit-empty";
		const authorId = "edit-empty-author";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut", "anchor body");

		try {
			await stub.editDefinition({definitionId, actorId: authorId, body: "   "});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/boş olamaz|gerekli/i);
		}
	});

	it("rejects edits over 10 000 chars", async () => {
		const slug = "edit-too-long";
		const authorId = "edit-too-long-author";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut", "anchor body");

		try {
			await stub.editDefinition({
				definitionId,
				actorId: authorId,
				body: "x".repeat(10_001),
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/10\s?000|en fazla/i);
		}
	});

	it("ownership: non-author edit is rejected with UnauthorizedDefinitionMutationError", async () => {
		const slug = "edit-cross-user";
		const authorId = "owner-user";
		const otherId = "intruder-user";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut", "owner's body");

		try {
			await stub.editDefinition({
				definitionId,
				actorId: otherId,
				body: "i should not be able to write this",
			});
			throw new Error("expected rejection");
		} catch (err) {
			// Name preserved across the RPC boundary (the class identity is not —
			// `instanceof` doesn't survive workerd's RPC marshaling). The
			// resolver does the same `instanceof` check on the worker side, where
			// the class IS in scope.
			expect((err as Error).name).toBe("UnauthorizedDefinitionMutationError");
			expect((err as Error).message).toMatch(/not authorized/i);
		}

		// The body did NOT change.
		const term = await stub.getTerm();
		expect(term!.definitions[0]!.body).toContain("owner's body");
	});
});

describe("SozlukTerm.deleteDefinition — task_6", () => {
	it("soft-deletes the definition; getTerm filters it out; term aggregates decrement", async () => {
		const slug = "delete-happy";
		const authorId = "delete-author";
		const {stub, definitionId} = await seedDefinition(
			slug,
			authorId,
			"umut",
			"to be deleted body",
		);

		// Add a second definition so the term doesn't end up empty after delete.
		const second = await stub.addDefinition({
			authorId,
			authorName: "umut",
			body: "second definition that survives",
		});

		const before = await stub.getTerm();
		expect(before!.totalDefinitions).toBe(2);

		const result = await stub.deleteDefinition({definitionId, actorId: authorId});
		expect(result.deleted).toBe(true);

		// getTerm filters the soft-deleted row out.
		const after = await stub.getTerm();
		expect(after!.totalDefinitions).toBe(1);
		expect(after!.definitions[0]!.id).toBe(second.definitionId);

		// definition_view row gets `deleted_at` stamped via projection.
		const view = await waitForCondition(
			"SELECT deleted_at FROM definition_view WHERE id = ?",
			[definitionId],
			(r) => (r as {deleted_at: number | null}).deleted_at != null,
		);
		expect(view).not.toBeNull();
	});

	it("decrements definitionCount and totalScore on delete", async () => {
		const slug = "delete-aggregates";
		const authorId = "delete-agg-author";
		const voterId = "delete-agg-voter";
		const {stub, definitionId} = await seedDefinition(
			slug,
			authorId,
			"umut",
			"will be voted then deleted",
		);

		// Vote on it so totalScore goes to 1.
		await stub.voteDefinition({definitionId, voterId});
		const beforeDelete = await stub.getTerm();
		expect(beforeDelete!.totalScore).toBe(1);
		expect(beforeDelete!.totalDefinitions).toBe(1);

		await stub.deleteDefinition({definitionId, actorId: authorId});

		const afterDelete = await stub.getTerm();
		expect(afterDelete!.totalDefinitions).toBe(0);
		expect(afterDelete!.totalScore).toBe(0);
	});

	it("ownership: non-author delete is rejected", async () => {
		const slug = "delete-cross-user";
		const authorId = "owner-d";
		const otherId = "intruder-d";
		const {stub, definitionId} = await seedDefinition(
			slug,
			authorId,
			"umut",
			"owner's body to defend",
		);

		try {
			await stub.deleteDefinition({definitionId, actorId: otherId});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("UnauthorizedDefinitionMutationError");
		}

		const term = await stub.getTerm();
		expect(term!.totalDefinitions).toBe(1);
	});

	it("re-deleting an already-deleted definition is an idempotent no-op", async () => {
		const slug = "delete-idempotent";
		const authorId = "delete-idem-author";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut", "anchor body");
		// Need a non-deleted definition to keep the term meaningful afterwards.
		await stub.addDefinition({authorId, authorName: "umut", body: "second body"});

		await stub.deleteDefinition({definitionId, actorId: authorId});
		const second = await stub.deleteDefinition({definitionId, actorId: authorId});
		expect(second.deleted).toBe(false);
	});

	it("outbox: workflow.create failure leaves edit outbox rows; reconcileOutbox re-queues and clears", async () => {
		const slug = "edit-reconcile";
		const authorId = "edit-reconcile-author";
		const {stub, definitionId} = await seedDefinition(slug, authorId, "umut", "anchor body");

		const counts = await runInDurableObject(stub, async (instance: any) => {
			const original = instance.env.PHOENIX_PROJECTION.create.bind(
				instance.env.PHOENIX_PROJECTION,
			);
			let calls = 0;
			instance.env.PHOENIX_PROJECTION = {
				...instance.env.PHOENIX_PROJECTION,
				create: async (params: unknown) => {
					calls++;
					// Fail the first two calls (TermChanged + DefinitionEdited).
					if (calls <= 2) throw new Error("simulated workflow create failure");
					return original(params);
				},
			};

			try {
				await instance.editDefinition({
					definitionId,
					actorId: authorId,
					body: "fresh edited body",
				});
			} catch {
				/* swallow */
			}

			const before = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			await instance.reconcileOutbox();
			const after = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			return {beforeCount: before.length, afterCount: after.length};
		});

		expect(counts.beforeCount).toBe(2);
		expect(counts.afterCount).toBe(0);
	});
});
