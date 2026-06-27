/**
 * `Pasaport.hydrateProfile` headline-count sandbox-visibility wiring (#1312) — the
 * security fix sibling to #1309. The public profile HEADLINE counts
 * (`definitionCount` / `postCount` / `commentCount` on `ProfileView`) are computed
 * by `hydrateProfile` via `countByAuthor` across the three content tables. Each
 * count must carry the #1205 {@link sandboxVisibleWhere} predicate beside its
 * existing `removed_at IS NULL` guard, resolved against the request viewer — so a
 * visitor never learns HOW MANY un-promoted (sandboxed) contributions a çaylak has,
 * and the header agrees with the (#1309-fixed) feed for the same viewer.
 *
 * Unit-tier per ADR 0082: the predicate SEMANTICS (who sees what) are already proven
 * by `SandboxVisibility.unit.test.ts`; what THIS test proves is that the COUNT path
 * WIRES that predicate into every `countByAuthor` for every viewer kind, and that the
 * SAME viewer-aware count backs both the header (`lookupProfile`) and the feed's
 * `totalCount` (`listContributions`), so the two are consistent.
 *
 * `countByAuthor` resolves through `.then()` (a Promise, no `.toSQL()`), so unlike the
 * feed SELECTs its SQL can't be captured off the query builder — instead the count
 * statements execute against a RECORDING D1 binding whose `prepare(sql)` captures the
 * compiled SQL + bound params. The profile-row read (a builder, scripted) never hits
 * the binding, so the recorded set is exactly the three count statements.
 *
 * The viewer matrix (the count leak is closed iff):
 *   - anonymous / public — `sandboxed_at IS NULL` (live only, no viewer arm).
 *   - other member — `sandboxed_at IS NULL OR author_id = :viewerId`: the own arm is
 *     keyed to the VIEWER (not the profiled author), so it counts none of the çaylak's
 *     sandboxed rows ⇒ live-only.
 *   - the author (viewing own profile) — same predicate, but `author_id = :viewerId`
 *     now matches ALL their own rows ⇒ they DO count their own sandboxed content.
 *   - moderator — no sandbox restriction (`undefined` ⇒ dropped by `and()`) ⇒ full count.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {type Auth, makePasaportLive, Pasaport} from "./Pasaport.ts";

const inertAuth = {} as Auth;

const hasToSQL = (v: unknown): v is {toSQL: () => {sql: string; params: unknown[]}} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
	typeof v === "object" && v !== null && typeof (v as {then?: unknown}).then === "function";

interface RecordedQuery {
	sql: string;
	params: unknown[];
}

// A D1 binding that records the SQL + bound params of every statement it EXECUTES.
// The `countByAuthor` reads resolve through `.then()` ⇒ they execute here, so their
// compiled SQL lands in `recorded`; the feed/profile-row builders are captured off
// `.toSQL()` and never executed against this binding.
function recordingD1(): {binding: D1Database; recorded: RecordedQuery[]} {
	const recorded: RecordedQuery[] = [];
	// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed; only SQL compilation + bind recording is exercised, results are inert.
	const binding = {
		prepare(sql: string) {
			const entry: RecordedQuery = {sql, params: []};
			recorded.push(entry);
			const stmt = {
				bind(...args: unknown[]) {
					entry.params.push(...args);
					return stmt;
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
			};
			return stmt;
		},
		async batch() {
			return [];
		},
	} as unknown as D1Database;
	return {binding, recorded};
}

// Drives a Pasaport method over scripted `run` results: a query BUILDER (the
// profile-row / feed SELECT) is captured off `.toSQL()` and resolved to its scripted
// result without executing; a count PROMISE (`countByAuthor`'s `.then()`) is awaited
// so it executes against the recording binding (firing `prepare`), then resolved to
// its scripted result. `batch` is unreachable on these read paths.
function scriptedAccess(
	binding: D1Database,
	results: ReadonlyArray<unknown>,
): {access: DrizzleAccess; builderSql: string[]} {
	const renderDb = drizzle(binding, {schema, relations});
	const builderSql: string[] = [];
	const state = {i: 0};
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) =>
			Effect.promise(async () => {
				const built = fn(renderDb) as unknown;
				if (hasToSQL(built)) {
					builderSql.push(built.toSQL().sql);
				} else if (isThenable(built)) {
					await built;
				}
				return results[state.i++] as A;
			}),
		batch: () => Effect.die(new Error("profile-count reads must not batch")),
	};
	return {access, builderSql};
}

const pasaportOver = (access: DrizzleAccess) =>
	makePasaportLive(inertAuth).pipe(Layer.provide(Layer.succeed(Drizzle, access)));

const AUTHOR = "caylak-author";
const OTHER = "someone-else";
const MOD = "a-mod";

const viewers = {
	anonymous: {viewerId: null, canSeeSandboxed: false},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false},
	author: {viewerId: AUTHOR, canSeeSandboxed: false},
	moderator: {viewerId: MOD, canSeeSandboxed: true},
} satisfies Record<string, SandboxViewer>;

const PROFILE_ROW = {
	userId: AUTHOR,
	username: "caylak",
	displayName: "Çaylak",
	image: null,
	totalKarma: 0,
};

// `lookupProfile` issues: 1 profile-row SELECT (builder, scripted) then 3
// `countByAuthor` reads (def/post/comment) — four scripted `run` results. Only the
// three counts execute against the recording binding.
const lookupResults = [[PROFILE_ROW], 0, 0, 0] as const;

// `listContributions` issues: 3 feed SELECTs (builders) then 3 `countByAuthor`
// totals — six scripted results; only the three totals execute against the binding.
const feedResults = [[], [], [], 0, 0, 0] as const;

// Run `lookupProfile` for `AUTHOR` as seen by `sandboxViewer`; return the three
// recorded headline-count statements.
const recordHeaderCounts = (sandboxViewer: SandboxViewer) =>
	Effect.gen(function* () {
		const {binding, recorded} = recordingD1();
		const {access} = scriptedAccess(binding, [...lookupResults]);
		yield* Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.lookupProfile("caylak", {sandboxViewer});
		}).pipe(Effect.provide(pasaportOver(access)));
		return recorded;
	});

// Run `listContributions` for `AUTHOR` as seen by `sandboxViewer`; return the three
// recorded `totalCount` statements (the feed SELECTs don't hit the binding).
const recordFeedCounts = (sandboxViewer: SandboxViewer) =>
	Effect.gen(function* () {
		const {binding, recorded} = recordingD1();
		const {access} = scriptedAccess(binding, [...feedResults]);
		yield* Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.listContributions({authorId: AUTHOR, first: 10, sandboxViewer});
		}).pipe(Effect.provide(pasaportOver(access)));
		return recorded;
	});

describe("Pasaport headline counts — every count filters the sandbox (the #1312 leak)", () => {
	it.effect("hydrateProfile issues one COUNT per content kind (definition/post/comment)", () =>
		Effect.gen(function* () {
			const counts = yield* recordHeaderCounts(viewers.anonymous);
			assert.strictEqual(counts.length, 3, "definition + post + comment counts");
			for (const {sql} of counts) {
				assert.match(sql.toLowerCase(), /count\(\*\)/, "is a COUNT(*) read");
			}
		}),
	);

	it.effect("anonymous/public — every count is gated `sandboxed_at IS NULL`, NO viewer arm", () =>
		Effect.gen(function* () {
			const counts = yield* recordHeaderCounts(viewers.anonymous);
			for (const {sql} of counts) {
				const s = sql.toLowerCase();
				assert.match(s, /"removed_at" is null/, "keeps the removal guard");
				assert.match(s, /"sandboxed_at" is null/, "counts live content only");
				assert.notInclude(s, " or ", "anonymous count has no viewer-own-content OR arm");
			}
		}),
	);

	it.effect("another member — `sandboxed_at IS NULL OR author_id = :viewerId` (live only)", () =>
		Effect.gen(function* () {
			const counts = yield* recordHeaderCounts(viewers.otherMember);
			for (const {sql, params} of counts) {
				const s = sql.toLowerCase();
				assert.match(s, /"removed_at" is null/);
				assert.match(
					s,
					/"sandboxed_at" is null[)\s]*or[\s(]*"[a-z_]+"\."author_id" = \?/,
					"sandboxed-or-own predicate is wired",
				);
				// The own arm is keyed to the VIEWER, not the profiled author — so it counts
				// none of the çaylak's sandboxed rows ⇒ the visitor's count is live-only.
				assert.include(params as unknown[], OTHER, "own-content arm bound to the viewer id");
			}
		}),
	);

	it.effect("the author viewing their OWN profile — counts include their own sandboxed", () =>
		Effect.gen(function* () {
			const counts = yield* recordHeaderCounts(viewers.author);
			for (const {sql, params} of counts) {
				const s = sql.toLowerCase();
				assert.match(s, /"sandboxed_at" is null[)\s]*or[\s(]*"[a-z_]+"\."author_id" = \?/);
				// viewerId === authorId, so `author_id = :viewerId` matches ALL the author's
				// rows — including sandboxed — so they count their own sandboxed content.
				assert.include(params as unknown[], AUTHOR, "own-content arm bound to the author");
			}
		}),
	);

	it.effect("a moderator — NO sandbox restriction on any count (full count)", () =>
		Effect.gen(function* () {
			const counts = yield* recordHeaderCounts(viewers.moderator);
			for (const {sql} of counts) {
				const s = sql.toLowerCase();
				assert.match(s, /"removed_at" is null/, "removal guard still applies");
				assert.notInclude(s, "sandboxed_at", "a moderator gets no sandbox filter");
			}
		}),
	);

	it.effect("default (no viewer supplied) is fail-safe anonymous — sandboxed_at IS NULL", () =>
		Effect.gen(function* () {
			const {binding, recorded} = recordingD1();
			const {access} = scriptedAccess(binding, [...lookupResults]);
			yield* Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				yield* pasaport.lookupProfile("caylak");
			}).pipe(Effect.provide(pasaportOver(access)));
			assert.strictEqual(recorded.length, 3);
			for (const {sql} of recorded) {
				assert.match(sql.toLowerCase(), /"sandboxed_at" is null/, "missing viewer ⇒ public-only");
				assert.notInclude(sql.toLowerCase(), " or ", "no viewer arm for the fail-safe default");
			}
		}),
	);
});

describe("Pasaport — headline counts AGREE with the feed totalCount per-viewer (#1312 AC#3)", () => {
	// The header (`lookupProfile`→`hydrateProfile`) and the feed's `totalCount`
	// (`listContributions`) both flow through the SAME `countByAuthor(table, author,
	// viewer)`, so for any given viewer the three count statements are byte-identical —
	// the header total can never disagree with what the feed exposes.
	for (const [name, sandboxViewer] of Object.entries(viewers)) {
		it.effect(`${name} — header count SQL === feed totalCount SQL`, () =>
			Effect.gen(function* () {
				const header = yield* recordHeaderCounts(sandboxViewer);
				const feed = yield* recordFeedCounts(sandboxViewer);
				const norm = (qs: RecordedQuery[]) => qs.map((q) => ({sql: q.sql, params: q.params}));
				assert.deepStrictEqual(
					norm(header),
					norm(feed),
					"the same viewer-aware count backs both the header and the feed total",
				);
			}),
		);
	}
});
