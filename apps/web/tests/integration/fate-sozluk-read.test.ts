/**
 * fate sozluk reads — end-to-end against the live worker `/fate` route.
 *
 * Drives the real `/fate` HTTP surface inside workerd via `SELF.fetch`, after
 * seeding `definition_view` + `term_summary` through the `SozlukAdmin` service
 * (same `env.PHOENIX_DB` the worker reads). Asserts wire parity with the
 * GraphQL sozluk read surface:
 *
 *   - `terms(sort)` returns the term rows and slug cursors.
 *   - `term(slug)` returns the detail row.
 *   - `term(slug){ definitions }` paginates via a DB keyset in the canonical
 *     term-page order `(score desc, created_at asc, id asc)`, with definition
 *     id as the cursor — no skips or duplicates across pages.
 *   - `Definition` nodes carry the same scalar surface as GraphQL
 *     (`id, body, score, author, authorId, myVote`).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env, SELF} from "cloudflare:test";
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {type Sozluk, SozlukLive} from "../../worker/features/sozluk/Sozluk";
import {SozlukAdmin, SozlukAdminLive} from "../../worker/features/sozluk/SozlukAdmin";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = Layer.mergeAll(
	SozlukLive.pipe(Layer.provideMerge(VoteLive)),
	SozlukAdminLive,
).pipe(Layer.provide(DrizzleLive), Layer.provide(Layer.succeed(CloudflareEnv, env)));

const run = <A, E, R extends Sozluk | SozlukAdmin>(eff: Effect.Effect<A, E, R>) =>
	Effect.runPromise(eff.pipe(Effect.provide(TestLive)) as Effect.Effect<A, E, never>);

async function applyViewMigrations() {
	const statements = baselineMigration
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

type FateResult =
	| {ok: true; data: unknown; id: string}
	| {ok: false; error: {code: string; message?: string}; id: string};

async function fateOp(operation: Record<string, unknown>): Promise<FateResult> {
	const res = await SELF.fetch("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations: [{id: "1", ...operation}]}),
	});
	const body = (await res.json()) as {results: FateResult[]};
	return body.results[0]!;
}

const SLUG = "fate-read";

beforeAll(async () => {
	await applyViewMigrations();
	// Seed five definitions with distinct scores so the keyset order is
	// deterministic: (score desc, created_at asc, id asc).
	await run(
		Effect.gen(function* () {
			const admin = yield* SozlukAdmin;
			return yield* admin.seedTerm({
				slug: SLUG,
				title: "Fate Read",
				definitions: [
					{authorId: "u1", authorName: "umut", body: "alpha definition", score: 50},
					{authorId: "u2", authorName: "elif", body: "beta definition", score: 40},
					{authorId: "u3", authorName: "ada", body: "gamma definition", score: 30},
					{authorId: "u4", authorName: "deniz", body: "delta definition", score: 20},
					{authorId: "u5", authorName: "kaan", body: "epsilon definition", score: 10},
				],
			});
		}),
	);
});

describe("fate sozluk reads — /fate", () => {
	it("terms(recent) returns rows with slug cursors", async () => {
		const result = await fateOp({
			kind: "list",
			name: "terms",
			args: {sort: "recent"},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			items: Array<{cursor: string; node: {slug: string; title: string; count: number}}>;
			pagination: {hasNext: boolean; hasPrevious: boolean};
		};
		const seeded = data.items.find((e) => e.node.slug === SLUG);
		expect(seeded).toBeDefined();
		expect(seeded!.cursor).toBe(SLUG); // cursor is the slug keyset
		expect(seeded!.node.title).toBe("Fate Read");
		expect(seeded!.node.count).toBe(5);
		expect(data.pagination.hasPrevious).toBe(false);
	});

	it("term(slug) returns the detail row", async () => {
		const result = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: SLUG},
			select: ["slug", "title", "count", "totalScore", "definitionCount"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			slug: string;
			title: string;
			count: number;
			totalScore: number;
		};
		expect(data.slug).toBe(SLUG);
		expect(data.title).toBe("Fate Read");
		expect(data.count).toBe(5);
		expect(data.totalScore).toBe(150);
	});

	it("term(slug) returns null for an unknown slug", async () => {
		const result = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: "does-not-exist"},
			select: ["slug"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("Term.definitions paginates by DB keyset with no skips/dupes across pages", async () => {
		// Page 1: first 2 in (score desc) order → alpha(50), beta(40).
		const page1 = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2}},
			select: ["slug", "definitions.id", "definitions.body", "definitions.score"],
		});
		expect(page1.ok).toBe(true);
		if (!page1.ok) return;
		const d1 = page1.data as {
			definitions: {
				items: Array<{cursor: string; node: {id: string; body: string; score: number}}>;
				pagination: {hasNext: boolean; nextCursor?: string};
			};
		};
		expect(d1.definitions.items.map((e) => e.node.score)).toEqual([50, 40]);
		expect(d1.definitions.items[0]!.node.body).toBe("alpha definition");
		expect(d1.definitions.pagination.hasNext).toBe(true);
		const cursor = d1.definitions.pagination.nextCursor;
		expect(cursor).toBeDefined();
		// Cursor is the last node's id (the keyset cursor).
		expect(cursor).toBe(d1.definitions.items[1]!.node.id);

		// Page 2: after the page-1 cursor → gamma(30), delta(20).
		const page2 = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2, after: cursor}},
			select: ["slug", "definitions.id", "definitions.score"],
		});
		expect(page2.ok).toBe(true);
		if (!page2.ok) return;
		const d2 = page2.data as {
			definitions: {
				items: Array<{cursor: string; node: {id: string; score: number}}>;
				pagination: {hasNext: boolean; nextCursor?: string};
			};
		};
		expect(d2.definitions.items.map((e) => e.node.score)).toEqual([30, 20]);
		expect(d2.definitions.pagination.hasNext).toBe(true);

		// Page 3: last one → epsilon(10), no more.
		const page3 = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 2, after: d2.definitions.pagination.nextCursor}},
			select: ["slug", "definitions.id", "definitions.score"],
		});
		expect(page3.ok).toBe(true);
		if (!page3.ok) return;
		const d3 = page3.data as {
			definitions: {
				items: Array<{node: {id: string; score: number}}>;
				pagination: {hasNext: boolean};
			};
		};
		expect(d3.definitions.items.map((e) => e.node.score)).toEqual([10]);
		expect(d3.definitions.pagination.hasNext).toBe(false);

		// No skips/dupes: the union of all page ids is exactly the 5 seeded.
		const allIds = [
			...d1.definitions.items.map((e) => e.node.id),
			...d2.definitions.items.map((e) => e.node.id),
			...d3.definitions.items.map((e) => e.node.id),
		];
		expect(new Set(allIds).size).toBe(5);
	});

	it("Definition nodes carry the GraphQL scalar surface (author/authorId/myVote)", async () => {
		const result = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 1}},
			select: [
				"definitions.id",
				"definitions.body",
				"definitions.author",
				"definitions.authorId",
				"definitions.score",
				"definitions.myVote",
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const node = (result.data as {definitions: {items: Array<{node: Record<string, unknown>}>}})
			.definitions.items[0]!.node;
		expect(node.author).toBe("umut");
		expect(node.authorId).toBe("u1");
		expect(node.score).toBe(50);
		// Anonymous viewer → myVote null (parity with GraphQL signed-out path).
		expect(node.myVote).toBeNull();
	});
});
