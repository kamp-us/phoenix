/**
 * `Pasaport.setRole` tuple-write fidelity against **real remote D1** (ADR 0082
 * integration tier, #3522) — the security-critical branch the unit tier can't reach.
 *
 * `role-mutation.unit.test.ts` drives the WIRE authority (fail-closed for a non-admin,
 * dark-ship inert) over a STUBBED `Pasaport`, so the domain write itself — the
 * `role === "moderator" ? insert(moderatorTuple).onConflictDoNothing() : delete(...)`
 * ternary inside `Pasaport.setRole` — never runs there, and an inverted ternary would
 * ship green (AC5). This drives the REAL `Pasaport.setRole` over the shipped D1 REST
 * transport and asserts the exact tuple the roster re-reads (`isModerator` /
 * `moderatorsAmong`): `moderator` grants the `(user, "moderates", platform)` tuple
 * (idempotently, `onConflictDoNothing`), `member` revokes it, and every change appends
 * an audited `user_role_event` row.
 *
 * Mirrors `kunye-relation-store.test.ts` (the same real-D1 RelationStore primitive over
 * `makeD1Rest` + `createDrizzle`) and `pasaport-ban.test.ts` (the sibling audit-log
 * mutation). Runs on the run-scoped SHARED stage (ADR 0104); every id is `NS`-prefixed
 * (this file's deterministic token) so its rows are its own and are cleaned up after.
 */
import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import type {RelationStore} from "@kampus/authz";
import {makeD1Rest, readYourWrite} from "@kampus/d1-rest";
import {and, eq, inArray} from "drizzle-orm";
import {Effect, Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {createDrizzle, type DrizzleDb, makeDrizzleLayer} from "../../worker/db/Drizzle.ts";
import * as schema from "../../worker/db/drizzle/schema.ts";
import {
	isModerator,
	moderatorTuple,
	type PlatformRole,
} from "../../worker/features/kunye/moderate.ts";
import {RelationStoreLive} from "../../worker/features/kunye/RelationStore.ts";
import {
	type BetterAuthInstance,
	makePasaportLive,
	Pasaport,
} from "../../worker/features/pasaport/Pasaport.ts";
import {rateLimitRetryingFetch} from "./_d1-rest-retry.ts";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);

// The data-plane writes/reads cross this REST transport, so its `fetch` carries the same
// 429-retry the sibling integration tests use (#3089): a transient CF 429 under
// merge_group load is re-sent with backoff at the transport, not thrown into drizzle.
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

// `setRole` never touches better-auth (no session/DB use on this path), so an inert
// instance satisfies the type — the same shape the Pasaport unit tests use.
const inertAuth = {} as BetterAuthInstance;

let db: DrizzleDb;
let layer: Layer.Layer<Pasaport | RelationStore>;

const userIds: string[] = [];

// Insert the target directly (the offline mint path — like `kunye-relation-store`'s
// `mint`): `setRole` rejects an unknown id up front, so the row must exist first.
const createUser = async (id: string) => {
	await db
		.insert(schema.user)
		.values({id, email: `${id}@test.local`, type: "human"})
		.run();
	userIds.push(id);
};

const runSetRole = (userId: string, role: PlatformRole) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			return yield* pasaport.setRole({userId, actorId: `${NS}-admin`, role});
		}).pipe(Effect.provide(layer)),
	);

const runIsModerator = (userId: string) =>
	Effect.runPromise(isModerator(userId).pipe(Effect.provide(layer)));

// The exact `(user, "moderates", platform)` row `setRole` writes — count it directly to
// prove the idempotent grant is a single row, not a duplicate.
const tupleCount = async (userId: string): Promise<number> => {
	const tuple = moderatorTuple(userId);
	const rows = await db
		.select({subject: schema.relationTuple.subject})
		.from(schema.relationTuple)
		.where(
			and(
				eq(schema.relationTuple.subject, tuple.subject),
				eq(schema.relationTuple.relation, tuple.relation),
				eq(schema.relationTuple.object, tuple.object),
			),
		)
		.all();
	return rows.length;
};

const auditRows = async (userId: string): Promise<Array<{role: string; actorId: string}>> => {
	const rows = await db
		.select({role: schema.userRoleEvent.role, actorId: schema.userRoleEvent.actorId})
		.from(schema.userRoleEvent)
		.where(eq(schema.userRoleEvent.userId, userId))
		.all();
	return rows;
};

// D1 REST carries no read-your-writes guarantee (replica lag), so poll the read to the
// truth this test just wrote under a bounded budget rather than assert once and flake.
const isModWhen = (userId: string, expected: boolean): Promise<boolean> =>
	readYourWrite(
		() => runIsModerator(userId),
		(observed) => observed === expected,
	);
const tupleCountWhen = (userId: string, expected: number): Promise<number> =>
	readYourWrite(
		() => tupleCount(userId),
		(observed) => observed === expected,
	);
const auditRowsWhen = (
	userId: string,
	predicate: (rows: Array<{role: string; actorId: string}>) => boolean,
): Promise<Array<{role: string; actorId: string}>> =>
	readYourWrite(() => auditRows(userId), predicate);

beforeAll(async () => {
	const {accountId, databaseId} = await h.d1Target();
	db = createDrizzle(makeD1Rest({accountId, databaseId, layer: restLayer}));
	const drizzleLayer = makeDrizzleLayer(db);
	layer = Layer.mergeAll(
		makePasaportLive(inertAuth).pipe(Layer.provide(drizzleLayer)),
		RelationStoreLive.pipe(Layer.provide(drizzleLayer)),
	);
});

afterAll(async () => {
	if (userIds.length === 0) return;
	// Tear down all three tables explicitly (the run is a direct REST transport — don't
	// lean on ON DELETE cascade): audit rows, the moderates tuple, then the user rows.
	await db.delete(schema.userRoleEvent).where(inArray(schema.userRoleEvent.userId, userIds)).run();
	await db.delete(schema.relationTuple).where(inArray(schema.relationTuple.subject, userIds)).run();
	await db.delete(schema.user).where(inArray(schema.user.id, userIds)).run();
});

describe("Pasaport.setRole — the real tuple write over real D1 (#3522 AC5)", () => {
	it("moderator grants the (user, moderates, platform) tuple — and re-grant is an idempotent no-op", async () => {
		const userId = `${NS}-grant`;
		await createUser(userId);

		// Before: not a moderator.
		expect(await isModWhen(userId, false)).toBe(false);

		const first = await runSetRole(userId, "moderator");
		expect(first.role).toBe("moderator");
		expect(await isModWhen(userId, true)).toBe(true);

		// Re-grant: `onConflictDoNothing` must neither error nor duplicate the tuple.
		const second = await runSetRole(userId, "moderator");
		expect(second.role).toBe("moderator");
		expect(await isModWhen(userId, true)).toBe(true);
		expect(await tupleCountWhen(userId, 1)).toBe(1);
	});

	it("member revokes the tuple — the roster read flips back to non-moderator", async () => {
		const userId = `${NS}-revoke`;
		await createUser(userId);

		await runSetRole(userId, "moderator");
		expect(await isModWhen(userId, true)).toBe(true);

		const revoked = await runSetRole(userId, "member");
		expect(revoked.role).toBe("member");
		expect(await isModWhen(userId, false)).toBe(false);
		expect(await tupleCountWhen(userId, 0)).toBe(0);
	});

	it("every role change appends an audited user_role_event row (actor, target, new role)", async () => {
		const userId = `${NS}-audit`;
		await createUser(userId);

		await runSetRole(userId, "moderator");
		await runSetRole(userId, "member");

		const rows = await auditRowsWhen(userId, (r) => r.length >= 2);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows.every((r) => r.actorId === `${NS}-admin`)).toBe(true);
		const roles = rows.map((r) => r.role);
		expect(roles).toContain("moderator");
		expect(roles).toContain("member");
	});
});
