/**
 * The moderation write→read seam end to end against **real remote Cloudflare D1**
 * (ADR 0082 integration tier, ADR 0107). This is the load-bearing key-alignment
 * proof: `@kampus/founder-seed`'s `seedFounders` (the offline WRITE path) mints the
 * `role='moderator'` cohort as `(id, "moderates", key(platform))` tuples, and the
 * worker's `Moderate.over(platform)` discharge (the runtime READ path, over
 * `RelationStoreLive` + `AgentAuthorityV1`) is run against the SAME D1 — so a
 * seeded founder mints a `Grant` and a non-founder is denied the invisible `Denied`.
 *
 * Crossing the two packages' object encodings on one real table is exactly what
 * catches a key divergence (the bug this seam closes: a bare `"platform"` write key
 * vs a `type:id` read key); a single-side unit test cannot. Both sides resolve the
 * object through `@kampus/authz`'s canonical `key(platform)`, so they cannot drift.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7); every id is `NS`-prefixed
 * (this file's deterministic token) to keep its rows its own, and the seeded
 * founder/tuple are cleaned up after each test.
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {CurrentActor, type Grant, human, isGrant, platform} from "@kampus/authz";
import {makeD1Rest} from "@kampus/d1-rest";
import {makeSeedDb, seedFounders} from "@kampus/founder-seed";
import {Effect, Exit, Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterEach, beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, makeDrizzleLayer} from "../../worker/db/Drizzle.ts";
import {AgentAuthorityV1} from "../../worker/features/kunye/AgentAuthorityV1.ts";
import type {Denied} from "../../worker/features/kunye/errors.ts";
import {Moderate} from "../../worker/features/kunye/moderate.ts";
import {RelationStoreLive} from "../../worker/features/kunye/RelationStore.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);

const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

const FOUNDER = `${NS}-founder`;
const RANDO = `${NS}-rando`;

// `d1` is the one binding both sides share: the founder-seed write path drizzles its
// own schema slice over it, the worker read path drizzles the full schema over it.
let d1: D1Database;
// Discharge `Moderate.over(platform)` for a subject over the SAME D1, to an Exit.
let discharge: (subject: string) => Promise<Exit.Exit<Grant<Moderate>, Denied>>;

const seedFounderUser = (id: string) =>
	d1
		.prepare("INSERT INTO user (id, email, role) VALUES (?, ?, ?)")
		.bind(id, `${id}@test.local`, "moderator")
		.run();

const cleanup = () =>
	Promise.all([
		d1.prepare("DELETE FROM relation_tuple WHERE subject IN (?, ?)").bind(FOUNDER, RANDO).run(),
		d1.prepare("DELETE FROM user WHERE id IN (?, ?)").bind(FOUNDER, RANDO).run(),
	]);

beforeAll(async () => {
	const {accountId, databaseId} = await h.d1Target();
	d1 = makeD1Rest({accountId, databaseId, layer: restLayer});
	const workerDb = createDrizzle(d1);
	const layer = Layer.mergeAll(
		RelationStoreLive.pipe(Layer.provide(makeDrizzleLayer(workerDb))),
		AgentAuthorityV1,
	);
	discharge = (subject) =>
		Effect.runPromise(
			Moderate.over(platform).pipe(
				Effect.provideService(CurrentActor, {actor: human(subject)}),
				Effect.provide(layer),
				Effect.exit,
			),
		);
});

afterEach(async () => {
	await cleanup();
});

describe("founder-seed write → Moderate.over(platform) read — the key-alignment seam (real D1)", () => {
	it("a seeded founder discharges a Grant; a non-founder is denied (invisible Denied)", async () => {
		await seedFounderUser(FOUNDER);
		const res = await seedFounders(makeSeedDb(d1), [FOUNDER]);
		expect(res.inserted).toBeGreaterThanOrEqual(1);

		const granted = await discharge(FOUNDER);
		expect(Exit.isSuccess(granted)).toBe(true);
		if (Exit.isSuccess(granted)) {
			expect(isGrant(granted.value)).toBe(true);
			expect(granted.value.scope.capability).toBe("kunye/Moderate");
		}

		const denied = await discharge(RANDO);
		expect(Exit.isFailure(denied)).toBe(true);
	});

	it("a revoked founder tuple denies the very next discharge (fresh per call)", async () => {
		await seedFounderUser(FOUNDER);
		await seedFounders(makeSeedDb(d1), [FOUNDER]);
		expect(Exit.isSuccess(await discharge(FOUNDER))).toBe(true);

		await d1.prepare("DELETE FROM relation_tuple WHERE subject = ?").bind(FOUNDER).run();
		expect(Exit.isFailure(await discharge(FOUNDER))).toBe(true);
	});
});
