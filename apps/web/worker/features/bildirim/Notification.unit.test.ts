/**
 * `Notification` domain coverage (#1694) — record / list / unreadCount / markRead
 * scoping, the decisions that are wrong-or-right with no engine (ADR 0040, ADR
 * 0082 T1/T2; `.patterns/effect-testing.md`). The `Drizzle` seam is substituted
 * directly (the `Funnel` idiom):
 *
 *   - **recipient scoping** — the exported pure builders' rendered SQL
 *     (`.toSQL()` over a no-op D1) is asserted to carry `recipient_id` in every
 *     read/write predicate, so "touch someone else's notification" matches zero
 *     rows by construction. This is the scoping AC's test.
 *   - **markRead** — end-to-end over the seam: the update's `changes` surfaces as
 *     `marked` (0 = foreign/unknown/already-read id, an idempotent no-op).
 *   - **list** — newest-first keyset paging: the `first + 1` probe folds into
 *     `{rows, hasNextPage, endCursor}`; a cursor that resolves to no row (foreign
 *     or dead id) is the shared cursor-miss empty page, never a probe.
 *   - **unreadCount / record** — the fold and the insert's field mapping.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, relations} from "../../db/Drizzle.ts";
import {
	bumpUnreadAggregateStatement,
	insertUnlessUnreadStatement,
	markAllReadStatement,
	markReadStatement,
	Notification,
	NotificationLive,
	unreadCountQuery,
} from "./Notification.ts";

// A real drizzle client over a no-op D1 — used ONLY to render `.toSQL()`; it
// never executes.
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

// A `Drizzle` seam that dispenses queued responses in order (the Funnel idiom).
const scriptedSequence = (responses: ReadonlyArray<unknown>): DrizzleAccess => {
	let call = 0;
	return {
		run: <A>(_fn: (db: never) => Promise<A>) => Effect.succeed(responses[call++] as A),
		batch: () => Effect.die(new Error("Notification issues no batch")),
	};
};

const notificationLayer = (access: DrizzleAccess) =>
	NotificationLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const row = (id: string, createdAt: Date, readAt: Date | null = null) => ({
	id,
	recipientId: "me",
	kind: "test",
	targetKind: "post" as const,
	targetId: "p1",
	actorId: null,
	count: 1,
	readAt,
	createdAt,
	updatedAt: createdAt,
});

describe("recipient scoping — every predicate carries recipient_id (the AC's enforcement site)", () => {
	it("markRead scopes to (id, recipient_id, read_at IS NULL)", () => {
		const {sql, params} = markReadStatement(renderDb, "me", "n1", new Date(0)).toSQL();
		assert.include(sql, '"id" = ?');
		assert.include(sql, '"recipient_id" = ?');
		assert.include(sql, '"read_at" is null');
		assert.include(params, "me");
		assert.include(params, "n1");
	});

	it("markAllRead scopes to (recipient_id, read_at IS NULL)", () => {
		const {sql, params} = markAllReadStatement(renderDb, "me", new Date(0)).toSQL();
		assert.include(sql, '"recipient_id" = ?');
		assert.include(sql, '"read_at" is null');
		assert.include(params, "me");
	});

	it("unreadCount scopes to (recipient_id, read_at IS NULL)", () => {
		const {sql, params} = unreadCountQuery(renderDb, "me").toSQL();
		assert.include(sql, '"recipient_id" = ?');
		assert.include(sql, '"read_at" is null');
		assert.include(params, "me");
	});
});

describe("Notification.markRead — changes → marked, idempotent no-op on 0", () => {
	it.effect("surfaces the update's changed-row count", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			const {marked} = yield* svc.markRead("me", "n1");
			assert.strictEqual(marked, 1);
		}).pipe(Effect.provide(notificationLayer(scriptedSequence([{meta: {changes: 1}}])))),
	);

	it.effect("a foreign/unknown/already-read id marks nothing (0 changes)", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			const {marked} = yield* svc.markRead("me", "not-mine");
			assert.strictEqual(marked, 0);
		}).pipe(Effect.provide(notificationLayer(scriptedSequence([{meta: {changes: 0}}])))),
	);
});

describe("Notification.unreadCount — the count fold", () => {
	it.effect("reads the grouped count row; an empty result reads 0", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			assert.strictEqual(yield* svc.unreadCount("me"), 3);
			assert.strictEqual(yield* svc.unreadCount("me"), 0);
		}).pipe(Effect.provide(notificationLayer(scriptedSequence([[{count: 3}], []])))),
	);
});

describe("Notification.listForRecipient — newest-first keyset paging", () => {
	it.effect("folds the first+1 probe into rows/hasNextPage/endCursor", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			const page = yield* svc.listForRecipient("me", {first: 2});
			assert.deepStrictEqual(
				page.rows.map((r) => r.id),
				["n3", "n2"],
			);
			assert.isTrue(page.hasNextPage);
			assert.strictEqual(page.endCursor, "n2");
		}).pipe(
			Effect.provide(
				notificationLayer(
					// One read (no cursor to resolve): the LIMIT 3 probe.
					scriptedSequence([
						[row("n3", new Date(3000)), row("n2", new Date(2000)), row("n1", new Date(1000))],
					]),
				),
			),
		),
	);

	it.effect("a cursor that resolves to no row (foreign or dead id) is the empty page", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			const page = yield* svc.listForRecipient("me", {first: 2, after: "someone-elses"});
			assert.deepStrictEqual(page.rows, []);
			assert.isFalse(page.hasNextPage);
			assert.isNull(page.endCursor);
		}).pipe(
			// The cursor-resolve read returns no row → miss → no second read issued.
			Effect.provide(notificationLayer(scriptedSequence([undefined]))),
		),
	);

	it.effect("a marked-read row keeps its readAt stamp on the way out", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			const page = yield* svc.listForRecipient("me", {first: 1});
			assert.deepStrictEqual(page.rows[0]?.readAt, new Date(500));
		}).pipe(
			Effect.provide(
				notificationLayer(scriptedSequence([[row("n1", new Date(1000), new Date(500))]])),
			),
		),
	);
});

const aggregateInput = {
	recipientId: "me",
	kind: "divan-vote",
	targetKind: "post" as const,
	targetId: "p1",
	actorId: null,
};

describe("recordAggregate builders — recipient-scoped, unread-only (the anti-hype upsert)", () => {
	it("the bump scopes to (recipient_id, kind, target_kind, target_id, read_at IS NULL) and adds 1", () => {
		const {sql, params} = bumpUnreadAggregateStatement(
			renderDb,
			aggregateInput,
			new Date(0),
		).toSQL();
		assert.include(sql, '"recipient_id" = ?');
		assert.include(sql, '"kind" = ?');
		assert.include(sql, '"target_kind" = ?');
		assert.include(sql, '"target_id" = ?');
		assert.include(sql, '"read_at" is null');
		assert.include(sql, '"count" + 1');
		assert.include(params, "me");
		assert.include(params, "p1");
	});

	it("the insert fires only when NO unread row exists for the same recipient-scoped key", () => {
		const {sql, params} = insertUnlessUnreadStatement(
			renderDb,
			{...aggregateInput, id: "n-new"},
			new Date(0),
		).toSQL();
		assert.include(sql.toLowerCase(), "not exists");
		assert.include(sql, '"recipient_id" = ?');
		assert.include(sql, '"read_at" is null');
		assert.include(params, "n-new");
		assert.include(params, "me");
	});
});

describe("Notification.recordAggregate — bump-or-insert in one batch", () => {
	const batchScripted = (results: ReadonlyArray<unknown>): DrizzleAccess => ({
		run: () => Effect.die(new Error("recordAggregate issues only a batch")),
		batch: () => Effect.succeed(results as never),
	});

	it.effect("an existing unread row is bumped — aggregated, never a second row", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			const {aggregated} = yield* svc.recordAggregate(aggregateInput);
			assert.isTrue(aggregated);
		}).pipe(
			Effect.provide(
				notificationLayer(batchScripted([{meta: {changes: 1}}, {meta: {changes: 0}}])),
			),
		),
	);

	it.effect("no unread row (first event, or post-mark-read) inserts a FRESH unread row", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			const {aggregated} = yield* svc.recordAggregate(aggregateInput);
			assert.isFalse(aggregated);
		}).pipe(
			Effect.provide(
				notificationLayer(batchScripted([{meta: {changes: 0}}, {meta: {changes: 1}}])),
			),
		),
	);
});

describe("Notification.record — the emitter write surface", () => {
	it.effect("inserts and returns a fresh id", () =>
		Effect.gen(function* () {
			const svc = yield* Notification;
			const {id} = yield* svc.record({
				recipientId: "me",
				kind: "test",
				targetKind: "post",
				targetId: "p1",
			});
			assert.isString(id);
			assert.isAbove(id.length, 0);
		}).pipe(Effect.provide(notificationLayer(scriptedSequence([{meta: {changes: 1}}])))),
	);
});
