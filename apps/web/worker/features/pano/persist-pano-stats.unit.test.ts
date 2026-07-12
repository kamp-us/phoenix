/**
 * Coverage for the `recomputePanoStats` → row-write coupling (#1337) — the seam
 * the fold-only `recompute-pano-stats.unit.test.ts` leaves untested. The pure fold
 * is proven in isolation there; what THIS file proves is that the fold's output is
 * wired into the `pano_stats` upsert by its thin port (`makePersistPanoStats`).
 *
 * `makePersistPanoStats(run)` is exercised directly with a scripted `run`: the
 * three live COUNTs replay canned totals, and the final upsert's `sql` template is
 * captured (not executed) and rendered with the SQLite dialect — no engine, ADR
 * 0082/0104/0105 (no revived `node:sqlite` fake, no `runFateOp`). Row-level
 * behavior on real D1 stays the integration tier's job; the column LANDING is what
 * is unit-reachable here.
 */
import {describe, it} from "@effect/vitest";
import {SQLiteDialect} from "drizzle-orm/sqlite-core";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {assert} from "vitest";
import type {DrizzleAccessOrDie, DrizzleDb} from "../../db/Drizzle.ts";

/** A rejection from the stubbed `run` thunk — dies, matching `run`'s `never` channel. */
class RunRejected extends Schema.TaggedErrorClass<RunRejected>()("test/RunRejected", {
	cause: Schema.Unknown,
}) {}

import {makePersistPanoStats} from "./pano-stats.ts";

const dialect = new SQLiteDialect();

// makePersistPanoStats issues four `run`s in order: the three live COUNTs (posts,
// comments, authors) then the `pano_stats` upsert. The first three replay canned
// totals; the upsert's `sql` template is captured and rendered — never executed.
function scriptedRun(counts: readonly [number, number, number]): {
	run: DrizzleAccessOrDie["run"];
	upsert: () => {sql: string; params: unknown[]};
} {
	const state = {i: 0};
	let rendered: {sql: string; params: unknown[]} | undefined;
	const run = (<A>(fn: (db: DrizzleDb) => Promise<A>) => {
		const idx = state.i++;
		if (idx < 3) return Effect.succeed(counts[idx] as A);
		// The upsert: a capturing `db.run` records the `sql` template; the dialect
		// renders it to `{sql, params}` without touching a real binding.
		// biome-ignore lint/plugin: a capturing DrizzleDb stub — only `.run` is exercised to record the rendered upsert; no query executes against a binding.
		const captureDb = {
			run: (query: unknown) => {
				rendered = dialect.sqlToQuery(query as never);
				return Promise.resolve({results: []});
			},
		} as unknown as DrizzleDb;
		return Effect.tryPromise({
			try: () => fn(captureDb),
			catch: (cause) => new RunRejected({cause}),
		}).pipe(Effect.orDie);
	}) as DrizzleAccessOrDie["run"];
	return {
		run,
		upsert: () => {
			assert.isDefined(rendered, "the pano_stats upsert was never issued");
			return rendered as {sql: string; params: unknown[]};
		},
	};
}

describe("makePersistPanoStats — the recomputePanoStats → pano_stats row-write coupling (#1337)", () => {
	it.effect("the fold output lands in the pano_stats upsert columns", () =>
		Effect.gen(function* () {
			const now = new Date("2024-06-01T12:00:00.000Z");
			const updatedAt = Math.floor(now.getTime() / 1000);
			const scripted = scriptedRun([5, 12, 3]);

			yield* makePersistPanoStats(scripted.run)(now);

			const {sql: upsertSql, params} = scripted.upsert();
			assert.match(upsertSql, /pano_stats/, "the upsert targets pano_stats");
			// recomputePanoStats({posts:5, comments:12, authors:3}, now) ⇒ the three
			// counts passed through + `now` floored to unix seconds, in column order.
			assert.deepStrictEqual(
				params,
				[5, 12, 3, updatedAt],
				"total_posts, total_comments, total_authors, updated_at land in order",
			);
		}),
	);
});
