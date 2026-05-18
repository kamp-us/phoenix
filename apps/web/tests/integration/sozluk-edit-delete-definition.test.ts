/**
 * Sozluk `editDefinition` / `deleteDefinition` — Effect service path
 * (effect-migration task 4).
 *
 * Exercises the service surface against `env.PHOENIX_DB`:
 *   1. Edit body → definition_view.body + body_excerpt + updated_at advance.
 *   2. Validation: empty body / >10 000 chars reject with the tagged errors
 *      (`sozluk/BodyRequired`, `sozluk/BodyTooLong`).
 *   3. Ownership: non-author edit / delete fails with
 *      `sozluk/UnauthorizedDefinitionMutation`.
 *   4. Delete soft-stamps deleted_at; getTerm filters it out;
 *      term_summary aggregates decrement.
 *   5. Idempotent re-delete on an already-deleted row returns deleted=false.
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

async function seedDefinition(slug: string, authorId: string, body: string) {
	const result = await runSozluk(
		Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			return yield* sozluk.addDefinition({
				termSlug: slug,
				authorId,
				authorName: "umut",
				body,
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

describe("sozluk.editDefinition", () => {
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

		const result = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.editDefinition({
					definitionId,
					actorId: authorId,
					body: "edited body — significantly different content here.",
				});
			}),
		);
		expect(result.body).toContain("edited body");

		const after = await env.PHOENIX_DB.prepare(
			"SELECT body, body_excerpt FROM definition_view WHERE id = ?",
		)
			.bind(definitionId)
			.first<{body: string; body_excerpt: string}>();
		expect(after!.body).toContain("edited body");
		expect(after!.body_excerpt).toContain("edited body");

		const term = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		expect(term!.definitions[0]!.body).toContain("edited body");
	});

	it("rejects edits with empty body (BodyRequired)", async () => {
		const slug = "edit-empty";
		const authorId = "edit-empty-author";
		const {definitionId} = await seedDefinition(slug, authorId, "anchor body");

		await expectFailureTag(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.editDefinition({definitionId, actorId: authorId, body: "   "});
			}).pipe(Effect.provide(TestLive)),
			"sozluk/BodyRequired",
		);
	});

	it("rejects edits over 10 000 chars (BodyTooLong)", async () => {
		const slug = "edit-too-long";
		const authorId = "edit-too-long-author";
		const {definitionId} = await seedDefinition(slug, authorId, "anchor body");

		await expectFailureTag(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.editDefinition({
					definitionId,
					actorId: authorId,
					body: "x".repeat(10_001),
				});
			}).pipe(Effect.provide(TestLive)),
			"sozluk/BodyTooLong",
		);
	});

	it("ownership: non-author edit is rejected with UnauthorizedDefinitionMutation", async () => {
		const slug = "edit-cross-user";
		const authorId = "owner-user";
		const otherId = "intruder-user";
		const {definitionId} = await seedDefinition(slug, authorId, "owner's body");

		await expectFailureTag(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.editDefinition({
					definitionId,
					actorId: otherId,
					body: "i should not be able to write this",
				});
			}).pipe(Effect.provide(TestLive)),
			"sozluk/UnauthorizedDefinitionMutation",
		);

		const term = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		expect(term!.definitions[0]!.body).toContain("owner's body");
	});
});

describe("sozluk.deleteDefinition", () => {
	it("soft-deletes the definition; getTerm filters it out; aggregates decrement", async () => {
		const slug = "delete-happy";
		const authorId = "delete-author";
		const {definitionId} = await seedDefinition(slug, authorId, "to be deleted body");

		// Add a second definition so the term doesn't end up empty.
		const second = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.addDefinition({
					termSlug: slug,
					authorId,
					authorName: "umut",
					body: "second definition that survives",
				});
			}),
		);

		const before = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		expect(before!.totalDefinitions).toBe(2);

		const result = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.deleteDefinition({definitionId, actorId: authorId});
			}),
		);
		expect(result.deleted).toBe(true);

		const after = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
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

		await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.voteDefinition({definitionId, voterId});
			}),
		);
		const beforeDelete = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		expect(beforeDelete!.totalScore).toBe(1);
		expect(beforeDelete!.totalDefinitions).toBe(1);

		await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.deleteDefinition({definitionId, actorId: authorId});
			}),
		);

		const afterDelete = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		// totalDefinitions reflects live count, totalScore re-sums live rows.
		expect(afterDelete!.totalDefinitions).toBe(0);
		expect(afterDelete!.totalScore).toBe(0);
	});

	it("ownership: non-author delete is rejected", async () => {
		const slug = "delete-cross-user";
		const authorId = "owner-d";
		const otherId = "intruder-d";
		const {definitionId} = await seedDefinition(slug, authorId, "owner's body to defend");

		await expectFailureTag(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.deleteDefinition({definitionId, actorId: otherId});
			}).pipe(Effect.provide(TestLive)),
			"sozluk/UnauthorizedDefinitionMutation",
		);

		const term = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		expect(term!.totalDefinitions).toBe(1);
	});

	it("re-deleting an already-deleted definition is an idempotent no-op", async () => {
		const slug = "delete-idempotent";
		const authorId = "delete-idem-author";
		const {definitionId} = await seedDefinition(slug, authorId, "anchor body");
		await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.addDefinition({
					termSlug: slug,
					authorId,
					authorName: "umut",
					body: "second body",
				});
			}),
		);

		await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.deleteDefinition({definitionId, actorId: authorId});
			}),
		);
		const second = await runSozluk(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.deleteDefinition({definitionId, actorId: authorId});
			}),
		);
		expect(second.deleted).toBe(false);
	});
});
