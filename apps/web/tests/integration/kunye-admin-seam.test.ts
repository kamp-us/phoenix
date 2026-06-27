/**
 * The admin write→read seam end to end against **real remote Cloudflare D1** (ADR
 * 0082 integration tier, ADR 0107) — the `admin` twin of `kunye-moderate-seam.test.ts`.
 * The load-bearing key-alignment proof: `@kampus/admin-grant`'s `assignAdmin` (the
 * offline WRITE path) mints `(subject, "admin", key(platform))`, and the worker's
 * `Admin.over(platform)` discharge (the runtime READ path, over `RelationStoreLive` +
 * `AgentAuthorityV1`) is run against the SAME D1 — so a granted admin mints a `Grant`
 * and a non-admin is denied the invisible `Denied`.
 *
 * Crossing the two packages' object encodings on one real table is exactly what
 * catches a key divergence (a bare `"platform"` write key vs a `type:id` read key); a
 * single-side unit test cannot. Both sides resolve the object through `@kampus/authz`'s
 * canonical `key(platform)`, so they cannot drift.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7); every id is `NS`-prefixed
 * (this file's deterministic token) to keep its rows its own, and the granted
 * user/tuple are cleaned up after each test.
 */

import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {assignAdmin, makeGrantDb, revokeAdmin} from "@kampus/admin-grant";
import {CurrentActor, type Grant, human, isGrant, platform} from "@kampus/authz";
import {makeD1Rest} from "@kampus/d1-rest";
import {Effect, Exit, Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterEach, beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, makeDrizzleLayer} from "../../worker/db/Drizzle.ts";
import {AgentAuthorityV1} from "../../worker/features/kunye/AgentAuthorityV1.ts";
import {Admin} from "../../worker/features/kunye/admin.ts";
import type {Denied} from "../../worker/features/kunye/errors.ts";
import {RelationStoreLive} from "../../worker/features/kunye/RelationStore.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);

const restLayer = Layer.merge(CredentialsFromEnv, FetchHttpClient.layer);

const ADMIN_USER = `${NS}-admin`;
const RANDO = `${NS}-rando`;

// `d1` is the one binding both sides share: the admin-grant write path drizzles its
// own schema slice over it, the worker read path drizzles the full schema over it.
let d1: D1Database;
// Discharge `Admin.over(platform)` for a subject over the SAME D1, to an Exit.
let discharge: (subject: string) => Promise<Exit.Exit<Grant<Admin>, Denied>>;

// Seed the user row the admin-grant selector resolves against (the grant resolves the
// subject through the `user` table before minting the tuple).
const seedUser = (id: string) =>
	d1
		.prepare("INSERT INTO user (id, email, type) VALUES (?, ?, 'human')")
		.bind(id, `${id}@test.local`)
		.run();

const cleanup = () =>
	Promise.all([
		d1.prepare("DELETE FROM relation_tuple WHERE subject IN (?, ?)").bind(ADMIN_USER, RANDO).run(),
		d1.prepare("DELETE FROM user WHERE id IN (?, ?)").bind(ADMIN_USER, RANDO).run(),
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
			Admin.over(platform).pipe(
				Effect.provideService(CurrentActor, {actor: human(subject)}),
				Effect.provide(layer),
				Effect.exit,
			),
		);
});

afterEach(async () => {
	await cleanup();
});

describe("admin-grant write → Admin.over(platform) read — the key-alignment seam (real D1)", () => {
	it("a granted admin discharges a Grant; a non-admin is denied (invisible Denied)", async () => {
		await seedUser(ADMIN_USER);
		const res = await assignAdmin(makeGrantDb(d1), {by: "id", value: ADMIN_USER});
		expect(res.inserted).toBe(1);

		const granted = await discharge(ADMIN_USER);
		expect(Exit.isSuccess(granted)).toBe(true);
		if (Exit.isSuccess(granted)) {
			expect(isGrant(granted.value)).toBe(true);
			expect(granted.value.scope.capability).toBe("kunye/Admin");
		}

		const denied = await discharge(RANDO);
		expect(Exit.isFailure(denied)).toBe(true);
	});

	it("a revoked admin tuple denies the very next discharge (fresh per call)", async () => {
		await seedUser(ADMIN_USER);
		await assignAdmin(makeGrantDb(d1), {by: "id", value: ADMIN_USER});
		expect(Exit.isSuccess(await discharge(ADMIN_USER))).toBe(true);

		await revokeAdmin(makeGrantDb(d1), {by: "id", value: ADMIN_USER});
		expect(Exit.isFailure(await discharge(ADMIN_USER))).toBe(true);
	});
});
