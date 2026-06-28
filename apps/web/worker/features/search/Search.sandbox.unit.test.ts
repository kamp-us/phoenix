/**
 * `Search.searchPosts` sandbox-visibility wiring (#1358) — the security fix: site
 * search must NOT leak a çaylak's sandboxed (pre-review) post to a non-author /
 * non-moderator searcher. `searchPosts` is a fourth read into `post_record`; like
 * the other three pano reads it must AND the #1205 {@link sandboxVisibleWhere}
 * predicate into the read, resolved against the request viewer.
 *
 * The FTS index keeps sandboxed rows (so an author/moderator CAN find their own via
 * search), so the mask is a read-time filter — and it must ride EVERY query over the
 * FTS table, not just the hydrate: `totalCount` and the keyset would otherwise count
 * and slot rows the viewer can't see (the #1312 count/pagination leak). This test
 * drives the real `SearchLive` service over a recording D1 *client* (no SQL engine,
 * ADR 0082) and asserts the rendered SQL of the count + keyset queries carries the
 * viewer's predicate. The predicate SEMANTICS (who sees what) are already proven by
 * `SandboxVisibility.unit.test.ts`; what THIS proves is that `searchPosts` WIRES that
 * predicate into both the count and the keyset for every viewer kind.
 *
 * The viewer matrix (the leak is closed iff):
 *   - anonymous / public — `sandboxed_at IS NULL` (live only, no viewer arm).
 *   - other member — `sandboxed_at IS NULL OR author_id = :viewerId`; the viewer is
 *     not the çaylak, so the author arm matches none of their rows → live only.
 *   - the author — same predicate, but `author_id = :viewerId` now matches their own
 *     rows → they DO find their own sandboxed posts.
 *   - moderator — no sandbox arm at all (`canSeeSandboxed` ⇒ `undefined`, dropped by
 *     `and()`) → sees everything. The always-on filter is a no-op for them; every
 *     viewer still excludes removed posts.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {createDrizzle, type DrizzleDb, makeDrizzleLayer} from "../../db/Drizzle.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {Search, SearchLive} from "./Search.ts";

/**
 * A recording D1 *client* (no SQL engine, ADR 0082): it records the SQL string of
 * every statement drizzle's d1 driver prepares and returns empty results, so the
 * service runs to completion (empty page) while we inspect the rendered queries.
 */
const recordingD1 = () => {
	const prepared: string[] = [];
	const stmt = {
		bind() {
			return stmt;
		},
		async all() {
			return {results: []};
		},
		async run() {
			return {results: [], success: true, meta: {}};
		},
		async raw() {
			return [];
		},
		async first() {
			return null;
		},
	};
	const client = {
		prepare(sql: string) {
			prepared.push(sql);
			return stmt;
		},
		async batch(stmts: unknown[]) {
			return stmts.map(() => ({results: [], success: true, meta: {}}));
		},
	};
	// biome-ignore lint/plugin: a recording D1 client (no SQL engine) can't be structurally typed as the full `D1Database`; the d1 driver only calls `prepare`/`batch`.
	const db = createDrizzle(client as unknown as D1Database);
	return {db, prepared};
};

/** Render the SQL the searchPosts service emits for `query` under `viewer`. */
const renderSearchSql = async (viewer: SandboxViewer, query = "yazilim"): Promise<string[]> => {
	const {db, prepared} = recordingD1();
	const layer = SearchLive.pipe(Layer.provide(makeDrizzleLayer(db as DrizzleDb)));
	await Effect.runPromise(
		Effect.gen(function* () {
			const search = yield* Search;
			yield* search.searchPosts({query, viewer});
		}).pipe(Effect.provide(layer)),
	);
	return prepared;
};

const countQuery = (sqls: string[]) => sqls.find((s) => /count\(\*\)/i.test(s));
const keysetQuery = (sqls: string[]) => sqls.find((s) => /order by/i.test(s) && /limit/i.test(s));

const anonymous: SandboxViewer = {viewerId: null, canSeeSandboxed: false};
const otherMember: SandboxViewer = {viewerId: "member-other", canSeeSandboxed: false};
const author: SandboxViewer = {viewerId: "caylak-author", canSeeSandboxed: false};
const moderator: SandboxViewer = {viewerId: "mod-1", canSeeSandboxed: true};

describe("searchPosts — sandbox read-mask wired into BOTH count and keyset (#1358)", () => {
	it("anonymous/public: live-only — `sandboxed_at is null`, no author arm, on count AND keyset", async () => {
		const sqls = await renderSearchSql(anonymous);
		const count = countQuery(sqls);
		const keyset = keysetQuery(sqls);
		expect(count).toBeDefined();
		expect(keyset).toBeDefined();
		for (const q of [count!, keyset!]) {
			expect(q).toMatch(/in \(+select .*"post_record"/i);
			expect(q).toMatch(/"sandboxed_at" is null/i);
			// no per-viewer author arm for an anonymous searcher
			expect(q).not.toMatch(/"author_id" =/i);
		}
	});

	it("other member: `sandboxed_at is null or author_id = :viewerId` — own arm matches none of the çaylak's rows", async () => {
		const sqls = await renderSearchSql(otherMember);
		for (const q of [countQuery(sqls), keysetQuery(sqls)]) {
			expect(q).toBeDefined();
			expect(q).toMatch(/"sandboxed_at" is null[\s)]*or[\s(]*"post_record"\."author_id" = \?/i);
		}
	});

	it("the author: same predicate carries the author arm — they DO surface their own sandboxed posts", async () => {
		const sqls = await renderSearchSql(author);
		const keyset = keysetQuery(sqls);
		expect(keyset).toMatch(/"sandboxed_at" is null[\s)]*or[\s(]*"post_record"\."author_id" = \?/i);
	});

	it("moderator: no sandbox arm (always-on filter is a no-op) but removed posts still excluded", async () => {
		const sqls = await renderSearchSql(moderator);
		const count = countQuery(sqls);
		const keyset = keysetQuery(sqls);
		for (const q of [count, keyset]) {
			expect(q).toBeDefined();
			// the sandbox dimension is unrestricted for a moderator
			expect(q).not.toMatch(/"sandboxed_at"/i);
			// but the removal guard (ADR 0096) holds for every viewer
			expect(q).toMatch(/"removed_at" is null/i);
		}
	});

	it("omitting the viewer fails safe to anonymous (least privilege)", async () => {
		const {db, prepared} = recordingD1();
		const layer = SearchLive.pipe(Layer.provide(makeDrizzleLayer(db as DrizzleDb)));
		await Effect.runPromise(
			Effect.gen(function* () {
				const search = yield* Search;
				yield* search.searchPosts({query: "yazilim"});
			}).pipe(Effect.provide(layer)),
		);
		const keyset = keysetQuery(prepared);
		expect(keyset).toMatch(/"sandboxed_at" is null/i);
		expect(keyset).not.toMatch(/"author_id" =/i);
	});
});
