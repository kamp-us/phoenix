/**
 * Unit — the `Mecmua` write acts over a scripted `Drizzle` seam (the `Bookmark` /
 * `Vote.unit.test.ts` idiom, ADR 0082): `run` replays queued results so the pure
 * decisions are provable with no engine. Proves the ticket's write ACs (#2497):
 * `saveDraft` writes a PRIVATE draft (`publishedAt === null`) and allows MULTIPLE
 * drafts (distinct ids, never a probe-then-upsert), and `publish` STAMPS
 * `publishedAt` on the caller's own draft — refusing a foreign/absent id
 * (`MecmuaPostNotFound`) and an empty-title publish (`MecmuaTitleRequired`).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import type * as schema from "../../db/drizzle/schema.ts";
import {MecmuaPostNotFound, MecmuaTitleRequired} from "./errors.ts";
import {Mecmua, MecmuaLive} from "./Mecmua.ts";

type MecmuaRecord = typeof schema.mecmuaPost.$inferSelect;

/** A `Drizzle` whose `run` replays a queued result sequence; `batch` is unused here. */
const scriptedAccess = (results: ReadonlyArray<unknown>): DrizzleAccess => {
	const state = {i: 0};
	return {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("mecmua writes use run(), never batch()")),
	};
};

const mecmuaLayer = (access: DrizzleAccess) =>
	MecmuaLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const draft = (over: Partial<MecmuaRecord> = {}): MecmuaRecord => ({
	id: "mecmua_existing",
	slug: null,
	title: "Bir başlık",
	body: "gövde",
	authorId: "yzr",
	publishedAt: null,
	createdAt: new Date("2026-07-01T00:00:00.000Z"),
	updatedAt: new Date("2026-07-01T00:00:00.000Z"),
	...over,
});

describe("Mecmua.saveDraft — a private draft, multiple allowed", () => {
	it.effect("writes a draft with publishedAt === null (private) and a mecmua_ id", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const row = yield* mecmua.saveDraft({authorId: "cyl", title: " Taslak ", body: "içerik"});
			assert.strictEqual(row.publishedAt, null);
			assert.strictEqual(row.title, "Taslak");
			assert.strictEqual(row.authorId, "cyl");
			assert.match(row.id, /^mecmua_/);
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([undefined, undefined])))),
	);

	it.effect("two saveDraft calls mint DISTINCT ids (multiple drafts, no upsert)", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const a = yield* mecmua.saveDraft({authorId: "yzr", title: "A"});
			const b = yield* mecmua.saveDraft({authorId: "yzr", title: "B"});
			assert.notStrictEqual(a.id, b.id);
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([undefined, undefined])))),
	);
});

describe("Mecmua.publish — stamps publishedAt on the caller's own draft", () => {
	it.effect("stamps a non-null publishedAt on a found, titled draft", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const row = yield* mecmua.publish({id: "mecmua_existing", authorId: "yzr"});
			assert.isNotNull(row.publishedAt);
			assert.strictEqual(row.id, "mecmua_existing");
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([draft(), undefined])))),
	);

	it.effect("re-publish keeps the original publishedAt (idempotent)", () =>
		Effect.gen(function* () {
			const already = new Date("2026-06-01T00:00:00.000Z");
			const mecmua = yield* Mecmua;
			const row = yield* mecmua.publish({id: "mecmua_existing", authorId: "yzr"});
			assert.strictEqual(row.publishedAt?.getTime(), already.getTime());
		}).pipe(
			Effect.provide(
				mecmuaLayer(
					scriptedAccess([draft({publishedAt: new Date("2026-06-01T00:00:00.000Z")}), undefined]),
				),
			),
		),
	);

	it.effect("a foreign/absent id is refused MecmuaPostNotFound", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const err = yield* mecmua.publish({id: "mecmua_missing", authorId: "yzr"}).pipe(Effect.flip);
			assert.instanceOf(err, MecmuaPostNotFound);
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([undefined])))),
	);

	it.effect("an empty-title draft is refused MecmuaTitleRequired", () =>
		Effect.gen(function* () {
			const mecmua = yield* Mecmua;
			const err = yield* mecmua.publish({id: "mecmua_existing", authorId: "yzr"}).pipe(Effect.flip);
			assert.instanceOf(err, MecmuaTitleRequired);
		}).pipe(Effect.provide(mecmuaLayer(scriptedAccess([draft({title: "   "})])))),
	);
});
