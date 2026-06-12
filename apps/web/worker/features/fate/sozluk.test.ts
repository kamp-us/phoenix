/**
 * fate-operation integration tests (T2, ADR 0040) — sozluk through the native
 * interpreter path (ADR 0041), asserting wire output, the mutation round-trip,
 * and topic publishes.
 *
 * Exercises the worker-as-runtime seam end-to-end through {@link runFateOp}:
 *
 *   1. Build `Drizzle` + the feature services from a bound D1 (here a
 *      `node:sqlite`-backed stand-in) via `makeFateLayer` — the same layer the
 *      worker init builds.
 *   2. Per op, {@link runFateOp} wraps that worker layer in a per-op
 *      `ManagedRuntime` (built and disposed inside the call — see
 *      `run-fate-op.ts`), builds the per-request pair — `currentUser` and the
 *      recording `LivePublisher` it owns — and hands
 *      `FateInterpreter.handleRequest` one `FateRequestContext` of
 *      `{currentUser, livePublisher}`.
 *   3. The interpreter runs each handler THROUGH that runtime — the same
 *      serving path the deployed worker runs (`FateServer.layer(fateConfig)`
 *      + the interpreter; ADR 0043).
 *
 * This runs in the node pool (no workerd): the alchemy worker can't load into
 * `@cloudflare/vitest-pool-workers` yet. The proof is the interpreter over
 * the worker-level layers, driven through `FateInterpreter.handleRequest`
 * exactly as the `/fate` route drives them.
 *
 * Asserts the `/fate` wire contract:
 *   - a sozluk query (`term`) and list (`terms`) return correct data,
 *   - a failing resolver maps to the correct wire error code (`me` anonymous →
 *     `UNAUTHORIZED`),
 *   - a sozluk mutation (`definition.add`) round-trips and the changed entity
 *     re-resolves over the same seam.
 *
 * Per-test DB isolation: each `it` builds its own worker layer over a fresh
 * `node:sqlite` handle ({@link freshDb}) and closes it in `finally`, so no rows
 * leak across cases (the `freshDb()` idiom from `Vote.test.ts`).
 */
import {liveConnectionTopic, liveEntityTopic} from "@nkzw/fate/server";
import {Layer} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {Database} from "../../db/Database";
import {createDrizzle} from "../../db/Drizzle";
import * as schema from "../../db/drizzle/schema";
import {makeSqliteTestDb, type SqliteD1} from "../../db/sqlite-d1.testing";
import {layerStub} from "../pasaport/better-auth.testing";
import {makeFateLayer, type WorkerFateServices} from "./layers";
import {runFateOp} from "./run-fate-op";

const SESSION_USER = {id: "u-writer", name: "umut", email: "umut@example.com"};
const SLUG = "fate-read";

/** The per-test in-memory D1; created in `beforeEach`, closed in `afterEach`. */
let sqlite: SqliteD1;
/** The per-test worker layer (Drizzle + features) over {@link sqlite}'s handle. */
let WorkerLive: Layer.Layer<WorkerFateServices>;

/**
 * Build a fresh worker layer over a new `node:sqlite` handle and seed the SLUG
 * term + three definitions. `WorkerLive` wraps the SAME handle every `runFateOp`
 * call hits (`Layer.succeed(Database)(sqlite.d1)` is a constant over a shared
 * object reference, so reuse across separate `runFateOp` runs is one database).
 */
async function freshDb(): Promise<void> {
	sqlite = makeSqliteTestDb();

	// `makeFateLayer` is a zero-arg layer with `R = Database | BetterAuth` (ADR
	// 0040). Provide the seam from the SAME handle the seeding writes to so
	// features and seeding share one database — the one-`sqlite` invariant is
	// type-enforced. The stub `BetterAuth` is enough: reads never reach the
	// session path (`Pasaport.validateSession`).
	WorkerLive = makeFateLayer.pipe(
		Layer.provide(Layer.merge(Layer.succeed(Database)(sqlite.d1), layerStub())),
	);

	const db = createDrizzle(sqlite.d1);

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
			termTitle: "Fate Read",
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
		title: "Fate Read",
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
}

beforeEach(async () => {
	await freshDb();
});

afterEach(() => {
	sqlite?.close();
});

describe("fate ops — sozluk reads", () => {
	it("terms(recent) returns rows with slug cursors", async () => {
		const {result} = await runFateOp(WorkerLive, {
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
		expect(seeded!.node.title).toBe("Fate Read");
		expect(seeded!.node.count).toBe(3);
	});

	it("term(slug) returns the detail row", async () => {
		const {result} = await runFateOp(WorkerLive, {
			kind: "query",
			name: "term",
			args: {slug: SLUG},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {slug: string; title: string; count: number; totalScore: number};
		expect(data.slug).toBe(SLUG);
		expect(data.title).toBe("Fate Read");
		expect(data.count).toBe(3);
		expect(data.totalScore).toBe(120);
	});

	it("term(slug) returns null for an unknown slug", async () => {
		const {result} = await runFateOp(WorkerLive, {
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
		const {result} = await runFateOp(WorkerLive, {kind: "query", name: "me", select: ["id"]});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});

describe("fate ops — sozluk mutation round-trip", () => {
	it("definition.add round-trips and the changed entity re-resolves over the same seam", async () => {
		const add = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: SLUG, body: "delta definition added via fate"},
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
		expect(created.body).toBe("delta definition added via fate");
		expect(created.score).toBe(0);
		expect(created.authorId).toBe(SESSION_USER.id);

		// Re-resolve the changed entity (the term it joined) over the SAME seam:
		// the new definition is now in the term's definition list, and the term's
		// count reflects it.
		const reread = await runFateOp(WorkerLive, {
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
		expect(found!.node.body).toBe("delta definition added via fate");
	});

	it("definition.add publishes to the term's args-scoped Term.definitions topic (ADR 0039)", async () => {
		const add = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: SLUG, body: "live-published definition"},
				select: ["id", "body"],
			},
			{auth: SESSION_USER},
		);
		expect(add.result.ok).toBe(true);
		if (!add.result.ok) return;
		// The mutation appends to `Term.definitions` keyed by the slug — the publish
		// must reach the ARGS-scoped topic the subscriber registered under, not the
		// procedure-wide global wildcard (the mis-route ADR 0039 guards against).
		const expectedKey = liveConnectionTopic("Term.definitions", {id: SLUG});
		expect(add.published).toContain(expectedKey);
		expect(add.published).not.toContain("connection:Term.definitions:*");
	});

	it("definition.vote publishes to the Definition entity topic (ADR 0039)", async () => {
		// Seed a definition to vote on.
		const add = await runFateOp(
			WorkerLive,
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: SLUG, body: "votable definition"},
				select: ["id"],
			},
			{auth: SESSION_USER},
		);
		expect(add.result.ok).toBe(true);
		if (!add.result.ok) return;
		const id = (add.result.data as {id: string}).id;

		const vote = await runFateOp(
			WorkerLive,
			{kind: "mutation", name: "definition.vote", input: {id}, select: ["id", "score"]},
			{auth: SESSION_USER},
		);
		expect(vote.result.ok).toBe(true);
		if (!vote.result.ok) return;
		expect(vote.published).toEqual([liveEntityTopic("Definition", id)]);
	});
});
