/**
 * `Pasaport.listContributions` sandbox-visibility WIRING (#1309): the public profile
 * contribution feed must not leak a çaylak's un-promoted content. The predicate semantics
 * are already proven in `SandboxVisibility.unit.test.ts`; what this proves is that every
 * per-table feed read carries the predicate, for every viewer kind. Rendered by reading
 * each statement's `.toSQL()` over a no-op D1 — no engine, so row-level filtering itself
 * stays integration-tier (ADR 0082).
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

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
const renderDb = drizzle(noopD1, {relations});

const inertAuth = {} as BetterAuthInstance;

const hasToSQL = (v: unknown): v is {toSQL: () => {sql: string; params: unknown[]}} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

// Replays scripted results in call order (three feed SELECTs return [], three counts 0).
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
	anonymous: {viewerId: null, canSeeSandboxed: false, seesSandboxedInPlace: false},
	otherMember: {viewerId: OTHER, canSeeSandboxed: false, seesSandboxedInPlace: false},
	author: {viewerId: AUTHOR, canSeeSandboxed: false, seesSandboxedInPlace: false},
	moderator: {viewerId: MOD, canSeeSandboxed: true, seesSandboxedInPlace: false},
} satisfies Record<string, SandboxViewer>;

// Only the three feed SELECTs return a renderable query builder; the `COUNT(*)` reads
// resolve through `.then()` to a Promise (no `.toSQL()`), so they are not captured here.
// The `totalCount` count carries the same predicate in the source.
const FEED_RESULTS = [[], [], [], 0, 0, 0] as const;

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
					// The OWN arm is keyed to the VIEWER, not the profiled author — so it matches none
					// of the çaylak's rows.
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
					// viewerId === authorId, so the own arm matches ALL the author's rows, sandboxed
					// ones included.
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
				// The column IS projected (for the per-item `sandboxed` flag), but the moderator's
				// WHERE carries NO sandbox FILTER — so they see every row.
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

const sandboxedDef = {
	id: "d-sandboxed",
	createdAt: new Date("2026-01-02T00:00:00Z"),
	score: 0,
	sandboxedAt: new Date("2026-01-03T00:00:00Z"),
	authorId: AUTHOR,
	bodyExcerpt: "in review",
	termSlug: "s",
	termTitle: "T",
};
const liveDef = {
	id: "d-live",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	score: 0,
	sandboxedAt: null,
	authorId: AUTHOR,
	bodyExcerpt: "live",
	termSlug: "s",
	termTitle: "T",
};

// Order: def/post/comment feed SELECTs, then the three COUNT(*) totals.
const readFeedAs = (sandboxViewer: SandboxViewer) =>
	Effect.gen(function* () {
		const {access} = scriptedAccess([[sandboxedDef, liveDef], [], [], 2, 0, 0]);
		const connection = yield* Effect.gen(function* () {
			const pasaport = yield* Pasaport;
			return yield* pasaport.listContributions({authorId: AUTHOR, first: 10, sandboxViewer});
		}).pipe(Effect.provide(pasaportOver(access)));
		return new Map(connection.rows.map((r) => [r.node.id, r.node]));
	});

// The per-item review-state flag (#1316) the status block badges "incelemede" off, now
// owner-scoped through `ownSandboxed`.
describe("Pasaport.listContributions — the per-item sandboxed flag (#1316)", () => {
	it.effect("flags a sandboxed item `sandboxed: true` and a live item `sandboxed: false`", () =>
		Effect.gen(function* () {
			const byId = yield* readFeedAs(viewers.author);
			assert.strictEqual(byId.get("d-sandboxed")?.sandboxed, true, "sandboxed item flagged true");
			assert.strictEqual(byId.get("d-live")?.sandboxed, false, "live item flagged false");
		}),
	);
});

/**
 * The two-field split (#6464) this feed was missing: `sandboxed` is the AUTHOR's own
 * "incelemede" signal, `sandboxedInPlace` is the #6423 in-place reader's marker about
 * somebody ELSE's row. Both derive from the resolved `SandboxViewer` the read carries, so
 * the fifth çaylak surface can no longer hand a reader the author-facing badge.
 */
describe("Pasaport.listContributions — the owner/reader split (#6464)", () => {
	const inPlaceReader = {
		viewerId: OTHER,
		canSeeSandboxed: false,
		seesSandboxedInPlace: true,
	} satisfies SandboxViewer;

	it.effect("the author reads their own row as `sandboxed`, never as the reader marker", () =>
		Effect.gen(function* () {
			const row = (yield* readFeedAs(viewers.author)).get("d-sandboxed");
			assert.strictEqual(row?.sandboxed, true);
			assert.strictEqual(row?.sandboxedInPlace, false, "the owner is not a reader of their own");
		}),
	);

	it.effect("the opted-in in-place reader gets the marker and NO owner flag", () =>
		Effect.gen(function* () {
			const row = (yield* readFeedAs(inPlaceReader)).get("d-sandboxed");
			assert.strictEqual(row?.sandboxed, false, "review state never leaves the author");
			assert.strictEqual(row?.sandboxedInPlace, true);
		}),
	);

	it.effect("a live row carries neither field for the in-place reader", () =>
		Effect.gen(function* () {
			const row = (yield* readFeedAs(inPlaceReader)).get("d-live");
			assert.strictEqual(row?.sandboxed, false);
			assert.strictEqual(row?.sandboxedInPlace, false, "nothing to mark on promoted work");
		}),
	);

	// Every non-author viewer reachable with `PHOENIX_CAYLAK_VISIBILITY` down: the flag is
	// what resolves `seesSandboxedInPlace`, so with it off there is no third viewer class and
	// `sandboxedInPlace` is structurally false — matching `SandboxVisibility.unit.test.ts`.
	const flagDownNonAuthors = {
		"a plain signed-in non-author": viewers.otherMember,
		"an anonymous viewer": viewers.anonymous,
		"a moderator": viewers.moderator,
	} satisfies Record<string, SandboxViewer>;

	for (const [label, viewer] of Object.entries(flagDownNonAuthors)) {
		it.effect(`${label} reads both fields false with the flag off`, () =>
			Effect.gen(function* () {
				const row = (yield* readFeedAs(viewer)).get("d-sandboxed");
				assert.strictEqual(row?.sandboxed, false, "owner flag is author-only");
				assert.strictEqual(row?.sandboxedInPlace, false, "marker is flag-gated");
			}),
		);
	}
});
