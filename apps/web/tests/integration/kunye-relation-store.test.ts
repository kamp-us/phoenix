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
import {makeD1Rest, readYourWrite} from "@kampus/d1-rest";
import {and, eq} from "drizzle-orm";
import {Effect, Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterEach, beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, type DrizzleDb, makeDrizzleLayer} from "../../worker/db/Drizzle.ts";
import * as schema from "../../worker/db/drizzle/schema.ts";
import {objectKey, RelationStoreLive} from "../../worker/features/kunye/RelationStore.ts";
import {rateLimitRetryingFetch} from "./_d1-rest-retry.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);

// Data-plane `has`/`mint`/`remove` cross this REST transport, so its `fetch` carries the same
// 429-retry the setup path has (#3089): a transient CF 429 (code 971) under merge_group load is
// re-sent with full-jitter backoff at the transport, not thrown into drizzle/`readYourWrite` (#3099).
const restLayer = Layer.merge(
	CredentialsFromEnv,
	FetchHttpClient.layer.pipe(
		Layer.provide(
			Layer.succeed(
				FetchHttpClient.Fetch,
				rateLimitRetryingFetch((input, init) => fetch(input, init)),
			),
		),
	),
);

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

// The mint/remove writes and the `has` read all cross makeD1Rest's REST transport, which carries
// no read-your-writes guarantee — the /query endpoint takes no D1 session bookmark (see
// `readYourWrite`), so an immediate read after a write can observe the pre-write state until the
// account's D1 fabric catches up (#3075 Signature B / #3078). Poll the read until it reflects the
// just-written truth this test controls, so the read-after-write assertion is deterministic rather
// than a stale coin-flip. `readYourWrite` returns the real read on exhaustion, so a genuinely-wrong
// result still fails the assertion loudly — this waits out latency, it does not mask a bug.
const hasWhen = (tuple: Relation, expected: boolean): Promise<boolean> =>
	readYourWrite(
		() => has(tuple),
		(observed) => observed === expected,
	);

describe("RelationStoreLive.has on real D1 — resolves composite-PK tuple existence", () => {
	it("a seeded tuple reads present; a non-matching tuple reads absent", async () => {
		await mint(SUBJECT);

		expect(await hasWhen({subject: SUBJECT, relation: RELATION, object}, true)).toBe(true);

		// No write targets these keys, so their absence is stable — assert directly.
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
		expect(await hasWhen({subject: SUBJECT, relation: RELATION, object}, true)).toBe(true);

		await remove(SUBJECT);
		expect(await hasWhen({subject: SUBJECT, relation: RELATION, object}, false)).toBe(false);
	});
});
