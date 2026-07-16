/**
 * `RelationStoreLive` against **real remote Cloudflare D1** (ADR 0082 integration
 * tier) — runs the production `has` lookup over the shipped REST transport
 * (`makeD1Rest` + `createDrizzle`, the worker's path) against this run's migrated D1
 * (incl. `0010_relation_tuple`), asserting the store's only-wrong-if-the-DB-differs
 * facts: the composite-PK existence read resolves a seeded `(subject, relation,
 * object)` tuple, a non-matching tuple reads absent, and a removed tuple denies on the
 * very next call (fresh per call, no cached authority — ADR 0107). The pure boolean
 * mapping + statement shape stay in the unit tier (`worker/features/kunye/`).
 *
 * The store has no fate/HTTP surface (the `Moderate`/`Admin` consumers are a later
 * child), so — like `@kampus/founder-seed`'s seed core — it is exercised in-process
 * over the real-D1 REST seam, not black-box over the worker. Tuples are seeded here by
 * a direct write (the offline mint path); the store only reads.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7), so every subject/object id is
 * prefixed with `NS` (this file's deterministic token) to keep its rows its own.
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {type Relation, RelationStore, resource} from "@kampus/authz";
import {makeD1Rest} from "@kampus/d1-rest";
import {and, eq} from "drizzle-orm";
import {Effect, Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterEach, beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, type DrizzleDb, makeDrizzleLayer} from "../../worker/db/Drizzle.ts";
import * as schema from "../../worker/db/drizzle/schema.ts";
import {objectKey, RelationStoreLive} from "../../worker/features/kunye/RelationStore.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);

const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

const object = resource("platform", NS);
const SUBJECT = `${NS}-alice`;
const RELATION = "moderates";

let db: DrizzleDb;
let has: (tuple: Relation) => Promise<boolean>;

const mint = (subject: string) =>
	db
		.insert(schema.relationTuple)
		.values({subject, relation: RELATION, object: objectKey(object)})
		.onConflictDoNothing()
		.run();

const remove = (subject: string) =>
	db
		.delete(schema.relationTuple)
		.where(
			and(
				eq(schema.relationTuple.subject, subject),
				eq(schema.relationTuple.relation, RELATION),
				eq(schema.relationTuple.object, objectKey(object)),
			),
		)
		.run();

beforeAll(async () => {
	const {accountId, databaseId} = await h.d1Target();
	db = createDrizzle(makeD1Rest({accountId, databaseId, layer: restLayer}));
	const layer = RelationStoreLive.pipe(Layer.provide(makeDrizzleLayer(db)));
	has = (tuple) =>
		Effect.runPromise(
			Effect.gen(function* () {
				return yield* (yield* RelationStore).has(tuple);
			}).pipe(Effect.provide(layer)),
		);
});

afterEach(async () => {
	await remove(SUBJECT);
});

// #3075 stopgap (reversible): retry-wrap so a transient real-D1 flake in merge_group retries
// instead of evicting clean, unrelated PRs from the merge queue. Retry, NOT skip — the real-D1
// coverage stays. `mint()` is onConflictDoNothing (retry-idempotent) and uses no seedTerm, so
// vitest.config's "no retry" seedTerm-dedup constraint isn't tripped here. Remove once #3075's
// durable ci.yml worker-relevance filter lands.
describe("RelationStoreLive.has on real D1 — resolves composite-PK tuple existence", {
	retry: 2,
}, () => {
	it("a seeded tuple reads present; a non-matching tuple reads absent", async () => {
		await mint(SUBJECT);

		expect(await has({subject: SUBJECT, relation: RELATION, object})).toBe(true);

		expect(await has({subject: `${NS}-rando`, relation: RELATION, object})).toBe(false);
		expect(await has({subject: SUBJECT, relation: "admin", object})).toBe(false);
		expect(
			await has({
				subject: SUBJECT,
				relation: RELATION,
				object: resource("platform", `${NS}-other`),
			}),
		).toBe(false);
	});

	it("a removed tuple is denied on the next call (fresh per call, no cached authority)", async () => {
		await mint(SUBJECT);
		expect(await has({subject: SUBJECT, relation: RELATION, object})).toBe(true);

		await remove(SUBJECT);
		expect(await has({subject: SUBJECT, relation: RELATION, object})).toBe(false);
	});
});
