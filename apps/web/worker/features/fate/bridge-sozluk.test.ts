/**
 * fate bridge on sozluk — the task-2 proof (ADR 0029).
 *
 * Exercises the new worker-as-runtime seam end-to-end without a per-request
 * `ManagedRuntime`:
 *
 *   1. Build `Drizzle` + the feature services ONCE from a bound D1 (here a
 *      `node:sqlite`-backed stand-in) via `makeFateLayer` — the same layer the
 *      worker init builds.
 *   2. Per "request", provide only `Auth` + `RequestContext`, capture the live
 *      service map with `Effect.context<FateEnv>()`, and hand it to
 *      `fateServer.handleRequest` through `adapterContext` (`{context, request}`).
 *   3. The bridge runs each resolver with
 *      `Effect.runPromiseExit(Effect.provide(effect, ctx.context))` — nothing is
 *      built or disposed per request.
 *
 * This runs in the node pool (no workerd): the alchemy worker can't load into
 * `@cloudflare/vitest-pool-workers` yet (task 7 migrates the harness). The proof
 * is the bridge + worker-level layers, driven through `fateServer.handleRequest`
 * exactly as the `/fate` route drives them.
 *
 * Asserts wire parity with the pre-migration `/fate` surface:
 *   - a sozluk query (`term`) and list (`terms`) return correct data,
 *   - a failing resolver maps to the correct wire error code (`me` anonymous →
 *     `UNAUTHORIZED`),
 *   - a sozluk mutation (`definition.add`) round-trips and the changed entity
 *     re-resolves over the same bridge.
 */
import {Effect, type Layer} from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createDrizzle} from "../../db/Drizzle";
// `?raw` so the node/unit pool imports the SQL as a string (the pool-workers
// project transforms `.sql` to a string by default; the node pool does not).
import baselineMigration from "../../db/drizzle/migrations/0000_d1_baseline.sql?raw";
import * as schema from "../../db/drizzle/schema";
import {Auth} from "../pasaport/Auth";
import {makeSqliteD1, type SqliteD1} from "./__support__/sqlite-d1";
import {type FateEnv, makeFateLayer, type WorkerFateServices} from "./layers";
import {fateServer} from "./server";

let sqlite: SqliteD1;
/** The worker-level layer (Drizzle + features), built once over the bound D1. */
let WorkerLive: Layer.Layer<WorkerFateServices>;

const SESSION_USER: {id: string; name: string; email: string} = {
	id: "u-writer",
	name: "umut",
	email: "umut@example.com",
};

/**
 * Drive one fate operation through the bridge the way the `/fate` route does:
 * provide per-request `Auth` + `HttpServerRequest`, capture the `Context`, and
 * run `fateServer.handleRequest`. `auth` chooses the session (anonymous by
 * default).
 */
async function fateOp(
	operation: Record<string, unknown>,
	opts: {auth?: {id: string; name: string; email: string}} = {},
) {
	const request = new Request("https://test.local/fate", {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({version: 1, operations: [{id: "1", ...operation}]}),
	});

	const captureAndServe = Effect.gen(function* () {
		// The captured map carries the worker-level services PLUS the per-request
		// Auth/HttpServerRequest provided just below — the full FateEnv.
		const context = yield* Effect.context<FateEnv>();
		const res = yield* Effect.promise(() => fateServer.handleRequest(request, {request, context}));
		return res;
	}).pipe(
		Effect.provideService(Auth, {
			user: opts.auth as never,
			session: undefined,
		}),
		Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
		Effect.provide(WorkerLive),
	);

	const res = await Effect.runPromise(captureAndServe);
	const body = (await res.json()) as {
		version: number;
		results: Array<
			| {ok: true; data: unknown; id: string}
			| {ok: false; error: {code: string; message?: string}; id: string}
		>;
	};
	return {status: res.status, result: body.results[0]!};
}

const SLUG = "bridge-read";

beforeAll(async () => {
	sqlite = makeSqliteD1();
	sqlite.applyMigration(baselineMigration);

	const db = createDrizzle(sqlite.d1);
	// `makeFateLayer` now takes a better-auth instance for `Pasaport.validateSession`;
	// the bridge tests never hit that path, so a typed no-op stand-in is enough.
	const fakeAuth = {api: {getSession: async () => null}} as unknown as Parameters<
		typeof makeFateLayer
	>[1];
	WorkerLive = makeFateLayer(db, fakeAuth);

	// Seed three definitions with distinct scores so the keyset order is
	// deterministic: (score desc, created_at asc, id asc). Written straight to the
	// canonical D1 tables — `term_summary` carries the count/total_score the
	// `terms` list reads; the `term` page recomputes them off `definition_view`.
	const now = new Date();
	const definitions = [
		{id: "def-alpha", authorId: "u1", authorName: "umut", body: "alpha definition", score: 50},
		{id: "def-beta", authorId: "u2", authorName: "elif", body: "beta definition", score: 40},
		{id: "def-gamma", authorId: "u3", authorName: "ada", body: "gamma definition", score: 30},
	];
	await db.insert(schema.definitionView).values(
		definitions.map((d) => ({
			id: d.id,
			authorId: d.authorId,
			authorName: d.authorName,
			termSlug: SLUG,
			termTitle: "Bridge Read",
			body: d.body,
			bodyExcerpt: d.body,
			score: d.score,
			createdAt: now,
			updatedAt: now,
			deletedAt: null,
			lastEventId: "",
		})),
	);
	await db.insert(schema.termSummary).values({
		slug: SLUG,
		title: "Bridge Read",
		firstLetter: SLUG.charAt(0),
		definitionCount: definitions.length,
		totalScore: definitions.reduce((s, d) => s + d.score, 0),
		excerpt: definitions[0]!.body,
		topDefinitionId: definitions[0]!.id,
		firstAt: now,
		lastActivityAt: now,
		lastEditAt: now,
		lastEventId: "",
	});
});

afterAll(() => {
	sqlite?.close();
});

describe("fate bridge — sozluk reads", () => {
	it("terms(recent) returns rows with slug cursors", async () => {
		const {result} = await fateOp({
			kind: "list",
			name: "terms",
			args: {sort: "recent"},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {
			items: Array<{cursor: string; node: {slug: string; title: string; count: number}}>;
		};
		const seeded = data.items.find((e) => e.node.slug === SLUG);
		expect(seeded).toBeDefined();
		expect(seeded!.cursor).toBe(SLUG);
		expect(seeded!.node.title).toBe("Bridge Read");
		expect(seeded!.node.count).toBe(3);
	});

	it("term(slug) returns the detail row", async () => {
		const {result} = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: SLUG},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {slug: string; title: string; count: number; totalScore: number};
		expect(data.slug).toBe(SLUG);
		expect(data.title).toBe("Bridge Read");
		expect(data.count).toBe(3);
		expect(data.totalScore).toBe(120);
	});

	it("term(slug) returns null for an unknown slug", async () => {
		const {result} = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: "nope"},
			select: ["slug"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("a failing resolver maps to its wire error code — me anonymous → UNAUTHORIZED", async () => {
		const {result} = await fateOp({kind: "query", name: "me", select: ["id"]});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});

describe("fate bridge — sozluk mutation round-trip", () => {
	it("definition.add round-trips and the changed entity re-resolves over the bridge", async () => {
		const add = await fateOp(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: SLUG, body: "delta definition added via bridge"},
				select: ["id", "body", "score", "author", "authorId"],
			},
			{auth: SESSION_USER},
		);
		expect(add.result.ok).toBe(true);
		if (!add.result.ok) return;
		const created = add.result.data as {
			id: string;
			body: string;
			score: number;
			author: string;
			authorId: string;
		};
		expect(created.id).toBeTruthy();
		expect(created.body).toBe("delta definition added via bridge");
		expect(created.score).toBe(0);
		expect(created.authorId).toBe(SESSION_USER.id);

		// Re-resolve the changed entity (the term it joined) over the SAME bridge:
		// the new definition is now in the term's definition list, and the term's
		// count reflects it.
		const reread = await fateOp({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 10}},
			select: ["slug", "count", "definitions.id", "definitions.body"],
		});
		expect(reread.result.ok).toBe(true);
		if (!reread.result.ok) return;
		const term = reread.result.data as {
			count: number;
			definitions: {items: Array<{node: {id: string; body: string}}>};
		};
		expect(term.count).toBe(4);
		const found = term.definitions.items.find((e) => e.node.id === created.id);
		expect(found).toBeDefined();
		expect(found!.node.body).toBe("delta definition added via bridge");
	});
});
