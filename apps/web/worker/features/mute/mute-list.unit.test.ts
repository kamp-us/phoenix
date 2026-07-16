/**
 * `mute.listMine` coverage (#3114, epic #2035) — the manage-my-mutes read model,
 * split across the two seams the ACs live on (ADR 0082):
 *
 *   - **the domain read** (`Mute.listMine`) over the substituted `Drizzle` seam: the
 *     muter-ownership predicate is asserted on the rendered SQL (`.toSQL()` over a
 *     no-op D1 — the `Notification.unit.test.ts` idiom), so "list someone else's
 *     mutes" carries `muter_id` by construction; the newest-first keyset paging folds
 *     the `first + 1` probe into `{rows, hasNextPage, endCursor}`, and a foreign/dead
 *     cursor is the shared cursor-miss empty page (never a probe into another muter's
 *     rows). A null viewer short-circuits with no read.
 *   - **the WIRE boundary** (the `mute.listMine` list resolver) through `resolveWire`
 *     (decode → `encodeWireError`): an anonymous caller is rejected `UNAUTHORIZED`
 *     before any read; with the `member-mute` flag OFF an authed caller is refused
 *     `MUTE_DISABLED` (the dark-ship containment); with the flag ON the page is
 *     hydrated with the muted member's profile handle in ONE batched pasaport read.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {drizzle} from "drizzle-orm/d1";
import {Cause, Effect, Exit, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import type {ProfileIdentityRow} from "../pasaport/Pasaport.ts";
import {lists} from "./lists.ts";
import {Mute, MuteLive, mutedMembersQuery} from "./Mute.ts";

// A real drizzle client over a no-op D1 — used ONLY to render `.toSQL()`; it never
// executes (the `Notification.unit.test.ts` render seam).
// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; nothing here executes against it.
const noopD1 = {
	prepare: () => ({
		bind() {
			return this;
		},
		async all() {
			return {results: []};
		},
		async first() {
			return null;
		},
		async run() {
			return {};
		},
		async raw() {
			return [];
		},
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {relations});

// A `Drizzle` whose every call throws — any path that reaches the DB seam fails the
// test, so a no-read short-circuit runs to completion against it (the "no read" proof).
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Mute read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Mute wrote a batch on a path that must short-circuit")),
};

// A `Drizzle` seam that dispenses queued responses in order (the Funnel idiom).
const scriptedSequence = (responses: ReadonlyArray<unknown>): DrizzleAccess => {
	let call = 0;
	return {
		run: <A>(_fn: (db: DrizzleDb) => Promise<A>) => Effect.succeed(responses[call++] as A),
		batch: () => Effect.die(new Error("Mute.listMine issues no batch")),
	};
};

const muteLayer = (access: DrizzleAccess) =>
	MuteLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const muteRow = (mutedId: string, createdAt: Date) => ({mutedId, createdAt});

describe("Mute.listMine — muter ownership scoping (rendered SQL, no engine)", () => {
	it("every read predicate carries muter_id and orders newest-mute-first", () => {
		const {sql, params} = mutedMembersQuery(renderDb, "me").toSQL();
		assert.include(sql, '"muter_id" = ?');
		assert.include(sql, "order by");
		assert.include(sql, '"created_at" desc');
		assert.include(sql, '"muted_id" desc');
		assert.include(params, "me");
	});
});

describe("Mute.listMine — no-read short-circuit", () => {
	it.effect("a null viewer → empty page without touching the DB", () =>
		Effect.gen(function* () {
			const mute = yield* Mute;
			const page = yield* mute.listMine(null);
			assert.deepStrictEqual(page.rows, []);
			assert.isFalse(page.hasNextPage);
			assert.isNull(page.endCursor);
		}).pipe(Effect.provide(muteLayer(throwingAccess))),
	);
});

describe("Mute.listMine — newest-first keyset paging", () => {
	it.effect("folds the first+1 probe into rows/hasNextPage/endCursor", () =>
		Effect.gen(function* () {
			const mute = yield* Mute;
			const page = yield* mute.listMine("me", {first: 2});
			assert.deepStrictEqual(
				page.rows.map((r) => r.mutedId),
				["u3", "u2"],
			);
			assert.isTrue(page.hasNextPage);
			assert.strictEqual(page.endCursor, "u2");
		}).pipe(
			// One read (no cursor to resolve): the LIMIT 3 probe returns 3 rows.
			Effect.provide(
				muteLayer(
					scriptedSequence([
						[
							muteRow("u3", new Date(3000)),
							muteRow("u2", new Date(2000)),
							muteRow("u1", new Date(1000)),
						],
					]),
				),
			),
		),
	);

	it.effect("a cursor that resolves to no row (foreign or dead id) is the empty page", () =>
		Effect.gen(function* () {
			const mute = yield* Mute;
			const page = yield* mute.listMine("me", {first: 2, after: "someone-elses"});
			assert.deepStrictEqual(page.rows, []);
			assert.isFalse(page.hasNextPage);
			assert.isNull(page.endCursor);
			// The cursor-resolve read returned no row → miss → no second read issued.
		}).pipe(Effect.provide(muteLayer(scriptedSequence([undefined])))),
	);

	it.effect("a live cursor pages strictly after it (the second read is the keyset page)", () =>
		Effect.gen(function* () {
			const mute = yield* Mute;
			const page = yield* mute.listMine("me", {first: 2, after: "u3"});
			assert.deepStrictEqual(
				page.rows.map((r) => r.mutedId),
				["u2", "u1"],
			);
			assert.isFalse(page.hasNextPage);
			assert.strictEqual(page.endCursor, "u1");
		}).pipe(
			// read #1 resolves the cursor to its created_at; read #2 is the keyset page.
			Effect.provide(
				muteLayer(
					scriptedSequence([
						{createdAt: new Date(3000)},
						[muteRow("u2", new Date(2000)), muteRow("u1", new Date(1000))],
					]),
				),
			),
		),
	);
});

// --- WIRE boundary: the `mute.listMine` list resolver through `resolveWire` ---

const VIEWER = {id: "u-viewer", email: "kaan@example.com", name: "kaan"};

const runtimeContextStub: BaseRuntimeContext = {
	Type: "mute-list-test",
	id: "mute-list-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(on),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service);

type ListMine = (typeof Mute.Service)["listMine"];

// A `Mute` whose `listMine` runs `impl` (or dies on contact) — a denied path that must
// short-circuit before the read proves it by failing the fail-on-contact default.
const muteStub = (impl?: ListMine) =>
	Layer.succeed(Mute, {
		listMine:
			impl ??
			((() => Effect.die("Mute.listMine reached on a path that must short-circuit")) as ListMine),
		set: () => Effect.die("Mute.set not exercised"),
		readMutedIds: () => Effect.die("Mute.readMutedIds not exercised"),
	} as typeof Mute.Service);

const pasaportStub = (rows: ReadonlyArray<ProfileIdentityRow>) =>
	makePasaportStub({
		getProfileIdentitiesByIds: (ids) => Effect.succeed(rows.filter((r) => ids.includes(r.userId))),
	});

const listMine = (user?: typeof VIEWER) =>
	resolveWire(lists["mute.listMine"], {
		args: {},
		select: ["id", "username", "displayName", "mutedAt"],
	}).pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
	);

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

describe("mute.listMine — CurrentUser gate + dark-ship (fail closed)", () => {
	it.effect("an anonymous caller is rejected UNAUTHORIZED — and never reaches the read", () =>
		Effect.gen(function* () {
			const exit = yield* listMine().pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(Effect.provide(Layer.mergeAll(flagsStub(true), muteStub(), pasaportStub([])))),
	);

	it.effect("with the flag OFF an authed caller is refused MUTE_DISABLED — no read", () =>
		Effect.gen(function* () {
			const exit = yield* listMine(VIEWER).pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "MUTE_DISABLED");
		}).pipe(Effect.provide(Layer.mergeAll(flagsStub(false), muteStub(), pasaportStub([])))),
	);

	it.effect("with the flag ON the page is hydrated with the muted member's handle", () =>
		Effect.gen(function* () {
			const connection = yield* listMine(VIEWER);
			assert.strictEqual(connection.items.length, 1);
			const [entry] = connection.items;
			assert.strictEqual(entry?.cursor, "u-target");
			assert.deepStrictEqual(entry?.node, {
				__typename: "MutedMember",
				id: "u-target",
				username: "kaan",
				displayName: "Kaan",
				mutedAt: new Date(2000).toISOString(),
			});
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					muteStub((viewerId) => {
						assert.strictEqual(viewerId, VIEWER.id, "the muter is the authed caller");
						return Effect.succeed({
							rows: [{mutedId: "u-target", mutedAt: new Date(2000)}],
							hasNextPage: false,
							endCursor: "u-target",
						});
					}),
					pasaportStub([
						{userId: "u-target", username: "kaan", displayName: "Kaan", totalKarma: 0},
					]),
				),
			),
		),
	);

	it.effect("a member absent from user_profile renders with a null handle", () =>
		Effect.gen(function* () {
			const connection = yield* listMine(VIEWER);
			assert.deepStrictEqual(connection.items[0]?.node, {
				__typename: "MutedMember",
				id: "u-ghost",
				username: null,
				displayName: null,
				mutedAt: new Date(1000).toISOString(),
			});
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					flagsStub(true),
					muteStub(() =>
						Effect.succeed({
							rows: [{mutedId: "u-ghost", mutedAt: new Date(1000)}],
							hasNextPage: false,
							endCursor: "u-ghost",
						}),
					),
					pasaportStub([]),
				),
			),
		),
	);
});
