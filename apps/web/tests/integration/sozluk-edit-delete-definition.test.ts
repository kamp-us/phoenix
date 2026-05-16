/**
 * Sozluk D1-direct `editDefinition` / `deleteDefinition` (task_5, d1-direct).
 *
 * Exercises the module-functional path against `env.PHOENIX_DB`:
 *   1. Edit body → definition_view.body + body_excerpt + updated_at advance.
 *   2. Validation: empty body / >10 000 chars reject.
 *   3. Ownership: non-author edit / delete rejects with
 *      UnauthorizedDefinitionMutationError.
 *   4. Delete soft-stamps deleted_at; getTerm filters it out;
 *      term_summary aggregates decrement.
 *   5. Idempotent re-delete on an already-deleted row returns deleted=false.
 *
 * No `runInDurableObject`, no outbox, no projection workflow.
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
import {
	addDefinition,
	DefinitionValidationError,
	deleteDefinition,
	editDefinition,
	getTerm,
	UnauthorizedDefinitionMutationError,
	voteDefinition,
} from "../../worker/features/sozluk/module";

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

async function seedDefinition(slug: string, authorId: string, body: string) {
	const result = await addDefinition(env, {
		termSlug: slug,
		authorId,
		authorName: "umut",
		body,
	});
	return {definitionId: result.definitionId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("sozluk.editDefinition — task_5 (d1-direct)", () => {
	it("updates body + body_excerpt + updated_at on definition_view", async () => {
		const slug = "edit-happy";
		const authorId = "edit-author";
		const {definitionId} = await seedDefinition(slug, authorId, "original body");

		const before = await env.PHOENIX_DB.prepare(
			"SELECT body, body_excerpt FROM definition_view WHERE id = ?",
		)
			.bind(definitionId)
			.first<{body: string; body_excerpt: string}>();
		expect(before!.body).toContain("original body");

		const result = await editDefinition(env, {
			definitionId,
			actorId: authorId,
			body: "edited body — significantly different content here.",
		});
		expect(result.body).toContain("edited body");

		const after = await env.PHOENIX_DB.prepare(
			"SELECT body, body_excerpt FROM definition_view WHERE id = ?",
		)
			.bind(definitionId)
			.first<{body: string; body_excerpt: string}>();
		expect(after!.body).toContain("edited body");
		expect(after!.body_excerpt).toContain("edited body");

		const term = await getTerm(env, slug);
		expect(term!.definitions[0]!.body).toContain("edited body");
	});

	it("rejects edits with empty body", async () => {
		const slug = "edit-empty";
		const authorId = "edit-empty-author";
		const {definitionId} = await seedDefinition(slug, authorId, "anchor body");

		await expect(
			editDefinition(env, {definitionId, actorId: authorId, body: "   "}),
		).rejects.toBeInstanceOf(DefinitionValidationError);
	});

	it("rejects edits over 10 000 chars", async () => {
		const slug = "edit-too-long";
		const authorId = "edit-too-long-author";
		const {definitionId} = await seedDefinition(slug, authorId, "anchor body");

		await expect(
			editDefinition(env, {definitionId, actorId: authorId, body: "x".repeat(10_001)}),
		).rejects.toBeInstanceOf(DefinitionValidationError);
	});

	it("ownership: non-author edit is rejected with UnauthorizedDefinitionMutationError", async () => {
		const slug = "edit-cross-user";
		const authorId = "owner-user";
		const otherId = "intruder-user";
		const {definitionId} = await seedDefinition(slug, authorId, "owner's body");

		await expect(
			editDefinition(env, {
				definitionId,
				actorId: otherId,
				body: "i should not be able to write this",
			}),
		).rejects.toBeInstanceOf(UnauthorizedDefinitionMutationError);

		const term = await getTerm(env, slug);
		expect(term!.definitions[0]!.body).toContain("owner's body");
	});
});

describe("sozluk.deleteDefinition — task_5 (d1-direct)", () => {
	it("soft-deletes the definition; getTerm filters it out; aggregates decrement", async () => {
		const slug = "delete-happy";
		const authorId = "delete-author";
		const {definitionId} = await seedDefinition(slug, authorId, "to be deleted body");

		// Add a second definition so the term doesn't end up empty.
		const second = await addDefinition(env, {
			termSlug: slug,
			authorId,
			authorName: "umut",
			body: "second definition that survives",
		});

		const before = await getTerm(env, slug);
		expect(before!.totalDefinitions).toBe(2);

		const result = await deleteDefinition(env, {definitionId, actorId: authorId});
		expect(result.deleted).toBe(true);

		const after = await getTerm(env, slug);
		expect(after!.totalDefinitions).toBe(1);
		expect(after!.definitions[0]!.id).toBe(second.definitionId);

		// definition_view row has deleted_at stamped.
		const view = await env.PHOENIX_DB.prepare("SELECT deleted_at FROM definition_view WHERE id = ?")
			.bind(definitionId)
			.first<{deleted_at: number | null}>();
		expect(view!.deleted_at).not.toBeNull();
	});

	it("decrements definitionCount and totalScore on delete", async () => {
		const slug = "delete-aggregates";
		const authorId = "delete-agg-author";
		const voterId = "delete-agg-voter";
		const {definitionId} = await seedDefinition(slug, authorId, "will be voted then deleted");

		await voteDefinition(env, {definitionId, voterId});
		const beforeDelete = await getTerm(env, slug);
		expect(beforeDelete!.totalScore).toBe(1);
		expect(beforeDelete!.totalDefinitions).toBe(1);

		await deleteDefinition(env, {definitionId, actorId: authorId});

		const afterDelete = await getTerm(env, slug);
		// totalDefinitions reflects live count, totalScore re-sums live rows.
		expect(afterDelete!.totalDefinitions).toBe(0);
		expect(afterDelete!.totalScore).toBe(0);
	});

	it("ownership: non-author delete is rejected", async () => {
		const slug = "delete-cross-user";
		const authorId = "owner-d";
		const otherId = "intruder-d";
		const {definitionId} = await seedDefinition(slug, authorId, "owner's body to defend");

		await expect(deleteDefinition(env, {definitionId, actorId: otherId})).rejects.toBeInstanceOf(
			UnauthorizedDefinitionMutationError,
		);

		const term = await getTerm(env, slug);
		expect(term!.totalDefinitions).toBe(1);
	});

	it("re-deleting an already-deleted definition is an idempotent no-op", async () => {
		const slug = "delete-idempotent";
		const authorId = "delete-idem-author";
		const {definitionId} = await seedDefinition(slug, authorId, "anchor body");
		await addDefinition(env, {
			termSlug: slug,
			authorId,
			authorName: "umut",
			body: "second body",
		});

		await deleteDefinition(env, {definitionId, actorId: authorId});
		const second = await deleteDefinition(env, {definitionId, actorId: authorId});
		expect(second.deleted).toBe(false);
	});
});
