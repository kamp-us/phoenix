/**
 * Headline-count sandbox-visibility wiring (#1312) — a visitor must not learn HOW MANY
 * sandboxed contributions a çaylak has. The predicate SEMANTICS are proven in
 * `SandboxVisibility.unit.test.ts`; what THIS proves is that every `countByAuthor`
 * WIRES the predicate in, for every viewer kind, and that the header and the feed's
 * `totalCount` share one count so they cannot disagree.
 *
 * `countByAuthor` resolves through `.then()`, so its SQL cannot be captured off the
 * query builder like the feed SELECTs. Instead the counts execute against a RECORDING
 * D1 binding; the builder reads never hit it, so `recorded` is exactly the counts.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	DrizzleError,
	relations,
} from "../../db/Drizzle.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

const inertAuth = {} as BetterAuthInstance;

const hasToSQL = (v: unknown): v is {toSQL: () => {sql: string; params: unknown[]}} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
	typeof v === "object" && v !== null && typeof (v as {then?: unknown}).then === "function";

interface RecordedQuery {
	sql: string;
	params: unknown[];
}

// Records the SQL + bound params of every statement it EXECUTES — so the `.then()`
// counts land in `recorded` and the `.toSQL()` builders never do.
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

// Drives a Pasaport method over scripted `run` results: a query BUILDER is captured
// off `.toSQL()` without executing; a count PROMISE is awaited so it executes against
// the recording binding.
function scriptedAccess(
	binding: D1Database,
	results: ReadonlyArray<unknown>,
): {access: DrizzleAccess; builderSql: string[]} {
	const renderDb = drizzle(binding, {relations});
	const builderSql: string[] = [];
	const state = {i: 0};
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) =>
			Effect.tryPromise({
				try: async () => {
					const built = fn(renderDb) as unknown;
					if (hasToSQL(built)) {
						builderSql.push(built.toSQL().sql);
					} else if (isThenable(built)) {
						await built;
					}
					return results[state.i++] as A;
				},
				catch: (cause) => new DrizzleError({cause}),
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
	anonymous: {viewerId: null, canSeeSandboxed: false, seesSandboxedInPlace: false},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false, seesSandboxedInPlace: false},
	author: {viewerId: AUTHOR, canSeeSandboxed: false, seesSandboxedInPlace: false},
	moderator: {viewerId: MOD, canSeeSandboxed: true, seesSandboxedInPlace: false},
} satisfies Record<string, SandboxViewer>;

const PROFILE_ROW = {
	userId: AUTHOR,
	username: "caylak",
	displayName: "Çaylak",
	image: null,
	totalKarma: 0,
};

// `lookupProfile` issues 1 profile-row SELECT then 3 counts — four scripted results.
const lookupResults = [[PROFILE_ROW], 0, 0, 0] as const;

// `listContributions` issues 3 feed SELECTs then 3 count totals — six scripted results.
const feedResults = [[], [], [], 0, 0, 0] as const;

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

// The by-id relation fetch path (#1406): same shape as `recordHeaderCounts`, reached
// by id rather than by username.
const recordByIdCounts = (sandboxViewer: SandboxViewer) =>
	Effect.gen(function* () {
		const {binding, recorded} = recordingD1();
		const {access} = scriptedAccess(binding, [...lookupResults]);
		yield* Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.lookupProfileById(AUTHOR, {sandboxViewer});
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
				// The own arm binds the VIEWER, not the profiled author, so none of the
				// çaylak's sandboxed rows are counted.
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
				// viewerId === authorId here, so the own arm matches all their rows.
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
	// Header and feed both flow through the SAME `countByAuthor`, so per viewer the three
	// statements are byte-identical and the two totals cannot disagree.
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

const normQuery = (qs: RecordedQuery[]) => qs.map((q) => ({sql: q.sql, params: q.params}));

// The recorded counts fire in def/post/comment order, so index 0/1/2 is that read.
const nthQuery = (qs: RecordedQuery[], i: number): RecordedQuery => {
	const q = qs[i];
	if (!q) throw new Error(`expected a recorded count statement at index ${i}`);
	return q;
};

describe("Pasaport — counts AGREE across fetch paths (root by-username vs by-id, #1406)", () => {
	// The by-id relation path shares `hydrateProfile`/`countByAuthor` with the root
	// by-username query, so per viewer the two produce byte-identical count statements.
	for (const [name, sandboxViewer] of Object.entries(viewers)) {
		it.effect(`${name} — by-username header count SQL === by-id count SQL`, () =>
			Effect.gen(function* () {
				const header = yield* recordHeaderCounts(sandboxViewer);
				const byId = yield* recordByIdCounts(sandboxViewer);
				assert.deepStrictEqual(
					normQuery(header),
					normQuery(byId),
					"the same viewer-aware count backs both the by-username and the by-id read",
				);
			}),
		);
	}
});

describe("Pasaport — countByAuthor routes through the #1359/0113 seam (#1406)", () => {
	// Only the post count carries the draft arm (`postVisibleWhere`, ADR 0113); the other
	// two tables have no draft dimension. Counts fire def/post/comment, so post is MIDDLE.
	it.effect("only the post count carries the draft arm (is_draft); def/comment do not", () =>
		Effect.gen(function* () {
			const counts = yield* recordByIdCounts(viewers.otherMember);
			assert.strictEqual(counts.length, 3, "definition + post + comment counts");
			const defCount = nthQuery(counts, 0);
			const postCount = nthQuery(counts, 1);
			const commentCount = nthQuery(counts, 2);
			assert.notInclude(defCount.sql.toLowerCase(), "is_draft", "definitions have no draft");
			assert.match(postCount.sql.toLowerCase(), /"is_draft" is not 1/, "posts carry the draft arm");
			assert.notInclude(commentCount.sql.toLowerCase(), "is_draft", "comments have no draft");
		}),
	);

	it.effect(
		"another member — post count excludes the author's drafts (is_draft, no own-arm match)",
		() =>
			Effect.gen(function* () {
				const postCount = nthQuery(yield* recordByIdCounts(viewers.otherMember), 1);
				const s = postCount.sql.toLowerCase();
				// The draft own-arm binds the VIEWER, so none of the çaylak's drafts count.
				assert.match(s, /"is_draft" is not 1[)\s]*or[\s(]*"[a-z_]+"\."author_id" = \?/);
				assert.include(
					postCount.params as unknown[],
					OTHER,
					"draft own-arm bound to the viewer id",
				);
			}),
	);

	it.effect("the author viewing own profile — post count INCLUDES their own drafts", () =>
		Effect.gen(function* () {
			const postCount = nthQuery(yield* recordByIdCounts(viewers.author), 1);
			const s = postCount.sql.toLowerCase();
			// viewerId === authorId here, so the draft own-arm matches their own rows.
			assert.match(s, /"is_draft" is not 1[)\s]*or[\s(]*"[a-z_]+"\."author_id" = \?/);
			assert.include(postCount.params as unknown[], AUTHOR, "draft own-arm bound to the author");
		}),
	);
});
