/**
 * Mute read-mask (#3113) — the decisions that are wrong-or-right with no database
 * (ADR 0082): the SQL arm {@link mutedAuthorsWhere} folds beside a read's existing
 * guards, the in-memory {@link isMutedAuthor} dual, and the {@link currentMutedIds}
 * flag gate. Row-level EXCLUSION against real D1 (each content surface actually
 * hiding a muted author's rows) is the integration tier's job, like the sandbox
 * filter (`SandboxVisibility.agreement` leaves execution to integration).
 *
 * The masked-read coverage per surface (present-without-mute / absent-with-mute /
 * flag-off-unchanged) is anchored on the two invariants those reds reduce to:
 *   - the arm is `undefined` (no clause) exactly when nothing is muted — so a
 *     flag-off read (empty set) is byte-for-byte today's read on every surface;
 *   - the arm is `author_id NOT IN (…)` when the muter has mutes — the one predicate
 *     the pano feed, pano thread, and sözlük definition reads all `and()` in.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {SQLiteDialect, sqliteTable, text} from "drizzle-orm/sqlite-core";
import {Effect, Layer} from "effect";
import {Flags} from "../flagship/Flags.ts";
import {RequestFlagOverrides} from "../flagship/FlagsContext.ts";
import {Mute} from "./Mute.ts";
import {currentMutedIds, isMutedAuthor, mutedAuthorsWhere} from "./read-mask.ts";

// A throwaway table carrying the one column the mask reads, for a stable rendered name.
const content = sqliteTable("content", {
	id: text("id").primaryKey(),
	authorId: text("author_id").notNull(),
});
const dialect = new SQLiteDialect();

describe("mutedAuthorsWhere — the SQL read arm (no clause unless something is muted)", () => {
	it("no mask when the set is undefined", () => {
		assert.strictEqual(mutedAuthorsWhere(content.authorId, undefined), undefined);
	});

	it("no mask when the set is empty (the flag-off / nothing-muted read is unchanged)", () => {
		assert.strictEqual(mutedAuthorsWhere(content.authorId, new Set()), undefined);
	});

	it("a non-empty set renders `author_id not in (…)` over the muted ids", () => {
		const where = mutedAuthorsWhere(content.authorId, new Set(["u-a", "u-b"]));
		assert.isDefined(where);
		const {sql, params} = dialect.sqlToQuery(where!);
		assert.match(sql, /"content"\."author_id" not in \(\?, \?\)/);
		assert.deepStrictEqual(params, ["u-a", "u-b"]);
	});
});

describe("isMutedAuthor — the in-memory dual for single-row reads", () => {
	it("false when there is no muted set", () => {
		assert.isFalse(isMutedAuthor("u-a", undefined));
	});
	it("false for an author the muter has not muted", () => {
		assert.isFalse(isMutedAuthor("u-a", new Set(["u-b"])));
	});
	it("true for a muted author", () => {
		assert.isTrue(isMutedAuthor("u-a", new Set(["u-a", "u-b"])));
	});
});

const runtimeContextStub: BaseRuntimeContext = {
	Type: "mute-read-mask-test",
	id: "mute-read-mask-test",
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

// `Mute` whose `readMutedIds` returns a fixed set — or dies on contact, proving a
// path that must short-circuit before the read (flag off / anonymous) never reaches it.
const muteStub = (
	readMutedIds?: (viewerId: string | null | undefined) => Effect.Effect<Set<string>>,
) =>
	Layer.succeed(Mute, {
		set: () => Effect.die("Mute.set not exercised"),
		listMine: () => Effect.die("Mute.listMine not exercised"),
		readMutedIds:
			readMutedIds ??
			(() => Effect.die("Mute.readMutedIds reached on a path that must short-circuit")),
	});

const resolve = (opts: {
	on: boolean;
	user?: {id: string} | undefined;
	mute: ReturnType<typeof muteStub>;
}) =>
	currentMutedIds.pipe(
		Effect.provideService(CurrentUser, {user: opts.user}),
		Effect.provideService(RuntimeContext, runtimeContextStub),
		Effect.provideService(RequestFlagOverrides, {cookieHeader: null, overridesAllowed: false}),
		Effect.provide(Layer.mergeAll(flagsStub(opts.on), opts.mute)),
	);

describe("currentMutedIds — flag-gated, viewer-scoped", () => {
	it.effect("flag OFF ⇒ the empty set, and Mute is never read (byte-for-byte today)", () =>
		Effect.gen(function* () {
			const ids = yield* resolve({on: false, user: {id: "u-muter"}, mute: muteStub()});
			assert.strictEqual(ids.size, 0);
		}),
	);

	it.effect("flag ON + anonymous ⇒ the empty set, Mute unread (no viewer to scope to)", () =>
		Effect.gen(function* () {
			const ids = yield* resolve({on: true, user: undefined, mute: muteStub()});
			assert.strictEqual(ids.size, 0);
		}),
	);

	it.effect("flag ON + signed-in ⇒ the muter's OWN muted set (viewer-scoped)", () =>
		Effect.gen(function* () {
			const ids = yield* resolve({
				on: true,
				user: {id: "u-muter"},
				mute: muteStub((viewerId) => {
					assert.strictEqual(
						viewerId,
						"u-muter",
						"reads the current viewer's mutes, not another's",
					);
					return Effect.succeed(new Set(["u-target"]));
				}),
			});
			assert.deepStrictEqual([...ids], ["u-target"]);
		}),
	);
});
