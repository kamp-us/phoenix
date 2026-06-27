/**
 * `Pasaport.listContributions` sandbox-visibility wiring (#1309) — the security
 * fix: the public profile contribution feed must NOT leak a çaylak's sandboxed
 * (un-promoted) content to a visitor. The feed unions three content tables
 * (definitions / posts / comments); each per-table read — AND its `totalCount`
 * count — must carry the #1205 {@link sandboxVisibleWhere} predicate beside its
 * existing `removed_at IS NULL` guard, resolved against the request viewer.
 *
 * Unit-tier per ADR 0082: the predicate SEMANTICS (who sees what) are already
 * proven by `SandboxVisibility.unit.test.ts` over `isVisibleTo` /
 * `sandboxVisibleWhere`; what THIS test proves is that `listContributions` WIRES
 * that predicate into every feed read for every viewer kind. Rendered by reading
 * each statement's `.toSQL()` over a no-op D1 (the `Sozluk.connection.unit.test.ts`
 * / `promotion-sweep.unit.test.ts` idiom) — no engine, so the row-level filtering
 * itself is the integration tier's job; the wiring is unit-reachable.
 *
 * The viewer matrix (the leak is closed iff):
 *   - anonymous / public — predicate is `sandboxed_at IS NULL` (live only, no
 *     viewer arm): a logged-out visitor sees only the çaylak's live content.
 *   - other member — `sandboxed_at IS NULL OR author_id = :viewerId`: since the
 *     viewer is NOT the çaylak, the author arm matches none of the çaylak's rows,
 *     so only live content returns.
 *   - the author (viewing own profile) — same predicate, but `author_id =
 *     :viewerId` now matches ALL their own rows, so they DO see their own
 *     sandboxed content.
 *   - moderator — no sandbox restriction at all (`undefined` ⇒ dropped by `and()`):
 *     a moderator sees everything.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import * as schema from "../../db/drizzle/schema.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {type Auth, makePasaportLive, Pasaport} from "./Pasaport.ts";

// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; only `.toSQL()` rendering is exercised, the scripted `run` never executes a query.
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
const renderDb = drizzle(noopD1, {schema, relations});

const inertAuth = {} as Auth;

const hasToSQL = (v: unknown): v is {toSQL: () => {sql: string; params: unknown[]}} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

// Captures every `run` builder's `.toSQL()`; replays scripted results in call order
// (the three feed SELECTs return [], the three `totalCount` counts return 0).
function scriptedAccess(results: ReadonlyArray<unknown>): {
	access: DrizzleAccess;
	queries: {sql: string; params: unknown[]}[];
} {
	const state = {i: 0};
	const queries: {sql: string; params: unknown[]}[] = [];
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			const built = fn(renderDb) as unknown;
			if (hasToSQL(built)) queries.push(built.toSQL());
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("listContributions must not batch")),
	};
	return {access, queries};
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

// listContributions issues, in order: 3 feed SELECTs (def/post/comment) then 3
// `COUNT(*)` totals. Six no-op `run` results cover both, but only the three feed
// SELECTs return a renderable query builder — the `COUNT(*)` reads resolve through
// `.then()` to a Promise (no `.toSQL()`), so they execute harmlessly against the
// no-op D1 and are not captured here. The feed SELECTs ARE the row-leak surface:
// the rows a visitor would see. (The `totalCount` count carries the same predicate
// in the source so the count can't leak either, verified by review.)
const FEED_RESULTS = [[], [], [], 0, 0, 0] as const;

// Render the three feed SELECTs (definition / post / comment) for `AUTHOR`'s feed
// as seen by `sandboxViewer`.
const renderFeed = (sandboxViewer: SandboxViewer) =>
	Effect.gen(function* () {
		const {access, queries} = scriptedAccess([...FEED_RESULTS]);
		yield* Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			yield* pasaport.listContributions({authorId: AUTHOR, first: 10, sandboxViewer});
		}).pipe(Effect.provide(pasaportOver(access)));
		return queries;
	});

describe("Pasaport.listContributions — every feed read filters the sandbox (the #1309 leak)", () => {
	it.effect("renders the three feed SELECTs — one per content kind (definition/post/comment)", () =>
		Effect.gen(function* () {
			const queries = yield* renderFeed(viewers.anonymous);
			assert.strictEqual(queries.length, 3, "definition + post + comment feed reads");
		}),
	);

	it.effect("anonymous/public — every read is gated `sandboxed_at IS NULL`, NO viewer arm", () =>
		Effect.gen(function* () {
			const queries = yield* renderFeed(viewers.anonymous);
			for (const {sql} of queries) {
				const s = sql.toLowerCase();
				assert.match(s, /"removed_at" is null/, "keeps the removal guard");
				assert.match(s, /"sandboxed_at" is null/, "filters sandboxed content (live only)");
				// No `OR author_id = :viewer` arm for an anonymous viewer — purely live.
				assert.notInclude(s, " or ", "anonymous predicate has no viewer-own-content OR arm");
			}
		}),
	);

	it.effect(
		"another member — `sandboxed_at IS NULL OR author_id = :viewerId` (live + only THEIR own)",
		() =>
			Effect.gen(function* () {
				const queries = yield* renderFeed(viewers.otherMember);
				for (const {sql, params} of queries) {
					const s = sql.toLowerCase();
					assert.match(s, /"removed_at" is null/);
					assert.match(
						s,
						/"sandboxed_at" is null[)\s]*or[\s(]*"[a-z_]+"\."author_id" = \?/,
						"sandboxed-or-own predicate is wired",
					);
					// The OWN arm is keyed to the VIEWER, not the profiled author — so it
					// matches none of the çaylak's rows ⇒ the visitor sees only live content.
					assert.include(params as unknown[], OTHER, "own-content arm bound to the viewer id");
				}
			}),
	);

	it.effect(
		"the author viewing their OWN profile — own arm bound to themselves (sees own sandboxed)",
		() =>
			Effect.gen(function* () {
				const queries = yield* renderFeed(viewers.author);
				for (const {sql, params} of queries) {
					const s = sql.toLowerCase();
					assert.match(s, /"sandboxed_at" is null[)\s]*or[\s(]*"[a-z_]+"\."author_id" = \?/);
					// viewerId === authorId, so the `author_id = :viewerId` arm matches ALL the
					// author's rows — including sandboxed ones — so the owner sees them.
					assert.include(
						params as unknown[],
						AUTHOR,
						"own-content arm bound to the author themselves",
					);
				}
			}),
	);

	it.effect("a moderator — NO sandbox restriction on any read (sees everything)", () =>
		Effect.gen(function* () {
			const queries = yield* renderFeed(viewers.moderator);
			for (const {sql} of queries) {
				const s = sql.toLowerCase();
				assert.match(s, /"removed_at" is null/, "removal guard still applies");
				// The column IS projected (for the per-item `sandboxed` flag, #1316), but the
				// moderator's WHERE carries NO sandbox FILTER — no `sandboxed_at IS NULL` and
				// no viewer-own-content OR arm — so they see every row.
				assert.notMatch(s, /"sandboxed_at" is null/, "a moderator gets no sandbox filter");
				assert.notInclude(s, " or ", "no viewer-own-content OR arm for a moderator");
			}
		}),
	);

	it.effect("default (no viewer supplied) is fail-safe anonymous — sandboxed_at IS NULL", () =>
		Effect.gen(function* () {
			const {access, queries} = scriptedAccess([...FEED_RESULTS]);
			yield* Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				yield* pasaport.listContributions({authorId: AUTHOR, first: 10});
			}).pipe(Effect.provide(pasaportOver(access)));
			for (const {sql} of queries) {
				assert.match(sql.toLowerCase(), /"sandboxed_at" is null/, "missing viewer ⇒ public-only");
			}
		}),
	);
});

// The per-item review-state flag (#1316) the #1291 status block badges "incelemede"
// off. Derived in the feed map as `sandboxed: sandboxed_at != null` — a bare
// boolean carrying no reviewer identity. Scripts feed rows (a sandboxed + a live
// one) and asserts each output node's flag, as the AUTHOR viewing their own profile
// (the only viewer who sees their own sandboxed content, #1309).
describe("Pasaport.listContributions — the per-item sandboxed flag (#1316)", () => {
	const sandboxedDef = {
		id: "d-sandboxed",
		createdAt: new Date("2026-01-02T00:00:00Z"),
		score: 0,
		sandboxedAt: new Date("2026-01-03T00:00:00Z"),
		bodyExcerpt: "in review",
		termSlug: "s",
		termTitle: "T",
	};
	const liveDef = {
		id: "d-live",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		score: 0,
		sandboxedAt: null,
		bodyExcerpt: "live",
		termSlug: "s",
		termTitle: "T",
	};

	it.effect("flags a sandboxed item `sandboxed: true` and a live item `sandboxed: false`", () =>
		Effect.gen(function* () {
			// Order: def/post/comment feed SELECTs, then the three COUNT(*) totals.
			const {access} = scriptedAccess([[sandboxedDef, liveDef], [], [], 2, 0, 0]);
			const connection = yield* Effect.gen(function* () {
				const pasaport = yield* Pasaport;
				return yield* pasaport.listContributions({
					authorId: AUTHOR,
					first: 10,
					sandboxViewer: viewers.author,
				});
			}).pipe(Effect.provide(pasaportOver(access)));

			const byId = new Map(connection.rows.map((r) => [r.node.id, r.node]));
			assert.strictEqual(byId.get("d-sandboxed")?.sandboxed, true, "sandboxed item flagged true");
			assert.strictEqual(byId.get("d-live")?.sandboxed, false, "live item flagged false");
		}),
	);
});
