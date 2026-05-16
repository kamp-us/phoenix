/**
 * SozlukTerm.addDefinition + outbox + DefinitionAdded projection — task_4.
 *
 * Exercises the producer pattern (ADR 0007) end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Auto-create-term: addDefinition on a fresh slug creates `term_meta`
 *      AND inserts the definition AND emits TermChanged + DefinitionAdded.
 *   3. Atomic outbox: on the happy path, the outbox row is written inside
 *      transactionSync alongside the definition; flushOutbox clears it.
 *   4. Validation: empty body and >10 000 char bodies reject with the right
 *      error code.
 *   5. Reconciliation: simulate a workflow.create failure → outbox row
 *      remains → reconcileOutbox re-queues and clears it.
 *   6. The DefinitionAdded projection lands a `definition_view` row.
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

async function waitForRow(sql: string, params: unknown[], attempts = 30): Promise<unknown> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sql)
			.bind(...params)
			.first();
		if (row) return row;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function expectRejection(promise: Promise<unknown>, match: RegExp): Promise<void> {
	try {
		await promise;
		throw new Error("expected rejection");
	} catch (err) {
		expect((err as Error).message).toMatch(match);
	}
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("SozlukTerm.addDefinition — task_4", () => {
	it("auto-creates the term + inserts the definition + writes definition_view via projection", async () => {
		const slug = "outbox-pattern";
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));

		const result = await stub.addDefinition({
			authorId: "u1",
			authorName: "umut",
			body: "Atomic durability primitive: write outbox row in same tx as the mutation; flush async.",
			termTitle: "Outbox Pattern",
		});

		expect(result.definitionId).toBeTruthy();
		expect(result.termCreated).toBe(true);

		const term = await stub.getTerm();
		expect(term).not.toBeNull();
		expect(term!.title).toBe("Outbox Pattern");
		expect(term!.totalDefinitions).toBe(1);
		expect(term!.definitions[0]!.author).toBe("umut");
		expect(term!.definitions[0]!.body).toContain("Atomic durability");

		// term_summary projection landed via TermChanged.
		const termSummary = await waitForRow("SELECT slug FROM term_summary WHERE slug = ?", [slug]);
		expect(termSummary).not.toBeNull();

		// definition_view projection landed via DefinitionAdded.
		const view = (await waitForRow(
			"SELECT id, term_slug, term_title, author_id, author_name, body_excerpt FROM definition_view WHERE id = ?",
			[result.definitionId],
		)) as {
			id: string;
			term_slug: string;
			term_title: string;
			author_id: string;
			author_name: string;
			body_excerpt: string;
		} | null;
		expect(view).not.toBeNull();
		expect(view!.term_slug).toBe(slug);
		expect(view!.term_title).toBe("Outbox Pattern");
		expect(view!.author_id).toBe("u1");
		expect(view!.author_name).toBe("umut");
		expect(view!.body_excerpt).toContain("Atomic durability");
	});

	it("derives the term title from the slug when termTitle is not supplied", async () => {
		const slug = "pure-function";
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
		await stub.addDefinition({
			authorId: "u2",
			authorName: "elif",
			body: "A function whose output depends only on its inputs and produces no observable side effects.",
		});

		const term = await stub.getTerm();
		// "pure-function" → "pure function"
		expect(term!.title).toBe("pure function");
	});

	it("rejects empty body", async () => {
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName("empty-body"));
		await expectRejection(
			stub.addDefinition({authorId: "u1", authorName: "umut", body: ""}),
			/boş olamaz|gerekli/i,
		);
		await expectRejection(
			stub.addDefinition({authorId: "u1", authorName: "umut", body: "   "}),
			/boş olamaz|gerekli/i,
		);
	});

	it("rejects bodies over 10 000 chars", async () => {
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName("too-long"));
		const body = "x".repeat(10_001);
		await expectRejection(
			stub.addDefinition({authorId: "u1", authorName: "umut", body}),
			/10\s?000|en fazla/i,
		);
	});

	it("flushOutbox clears the outbox row on success", async () => {
		const slug = "flush-clears";
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
		await stub.addDefinition({
			authorId: "u1",
			authorName: "umut",
			body: "writes happen in transactionSync; outbox row clears on flush.",
		});

		// After the call returns the outbox should be empty (flush ran inline
		// on the happy path).
		const remaining = await runInDurableObject(stub, async (instance: any) => {
			return instance.sql<{n: number}>`SELECT COUNT(*) as n FROM outbox`;
		});
		expect(remaining[0]!.n).toBe(0);
	});

	it("workflow.create failure leaves outbox row; reconcileOutbox re-queues and clears it", async () => {
		const slug = "reconcile-test";
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));

		// Drive a transactionSync mutation but stub workflow.create to throw on
		// the first attempt, then succeed on the reconcile pass.
		const eventIds = await runInDurableObject(stub, async (instance: any) => {
			const original = instance.env.PHOENIX_PROJECTION.create.bind(instance.env.PHOENIX_PROJECTION);
			let calls = 0;
			instance.env.PHOENIX_PROJECTION = {
				...instance.env.PHOENIX_PROJECTION,
				create: async (params: unknown) => {
					calls++;
					if (calls === 1) throw new Error("simulated workflow create failure");
					return original(params);
				},
			};

			// First call: addDefinition swallows the flushOutbox failure (it logs)
			// and the outbox row stays.
			try {
				await instance.addDefinition({
					authorId: "u9",
					authorName: "test",
					body: "verifies the reconcile re-queue path",
				});
			} catch {
				/* swallow */
			}

			const before = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			expect(before.length).toBe(1);

			// Reconcile retries — second create call succeeds → row deleted.
			await instance.reconcileOutbox();

			const after = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			return {beforeIds: before.map((r: any) => r.event_id), afterCount: after.length};
		});

		expect(eventIds.beforeIds.length).toBe(1);
		expect(eventIds.afterCount).toBe(0);
	});
});
