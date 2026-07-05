/**
 * Off-DB coverage for `makeBackfillHotScores` (#2131) — the one-time full `hot_score`
 * backfill: a windowless recompute + a run-once marker guard.
 *
 * The pure decay decision (`decayHotScores`) is proven in `db/hotScoreDecay.unit.test.ts`;
 * the stored-column → feed re-ordering over real remote D1 is the integration tier
 * (`tests/integration/pano-hot-score-backfill.test.ts`). What THIS file proves, off-DB
 * with a scripted `run`, is the two things the backfill adds over `refreshHotScores`:
 *
 *   1. WINDOWLESS — it recomputes an ANCIENT row (created 17 days ago, far outside the
 *      72h decay window `refreshHotScores` scopes to). A windowed query would never hand
 *      that row to the backfill, so it would produce no update; here it DOES, proving the
 *      selection reaches rows outside the window. The `run` replays the ancient row, and
 *      the assertion is that the backfill emits the collapsed `hot_score` UPDATE for it.
 *   2. RUN-ONCE — the marker read (`hot_score_backfill.findFirst`) short-circuits a second
 *      pass to a `ran: false` no-op with no select and no writes.
 *
 * No engine, no `node:sqlite` (ADR 0082/0104/0105): `run` is scripted by call order, and
 * the per-row UPDATE + the marker INSERT are captured via a builder-shaped capturing
 * `DrizzleDb`, never executed against a binding.
 */
import {describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {assert} from "vitest";
import type {DrizzleAccessOrDie, DrizzleDb} from "../../db/Drizzle.ts";
import {computeHotScore} from "../../db/hotScore.ts";
import {makeBackfillHotScores} from "./post-operations.ts";

interface Row {
	id: string;
	score: number;
	hotScore: number;
	createdAt: Date;
}

interface CapturedUpdate {
	set: Record<string, unknown>;
}

// The two unavoidable stub casts, each isolated behind a single suppressed helper (the
// persist-pano-stats.unit.test idiom): `asDb` shapes a partial capturing object as the
// `DrizzleDb` the closure receives, and `asRun` types the scripted closure as the
// `run` port. Nothing executes against a binding — no engine, ADR 0082/0104/0105.

// biome-ignore lint/plugin: a capturing DrizzleDb stub — only the methods the backfill invokes are present; no query runs against a binding.
const asDb = (o: object): DrizzleDb => o as unknown as DrizzleDb;

const asRun = (fn: <A>(build: (db: DrizzleDb) => Promise<A>) => Effect.Effect<A>) =>
	// biome-ignore lint/plugin: a scripted `run` port stub — replays canned reads / records write-builder calls; no binding is touched.
	fn as unknown as DrizzleAccessOrDie["run"];

/**
 * Script `run` for a backfill that has NOT run yet: call 0 is the marker read (no row),
 * call 1 is the row select (replays `rows`), the middle calls are the per-changed-row
 * UPDATEs (captured via the builder chain), and the last call is the marker INSERT
 * (captured). The capturing db mimics only the builder methods the backfill invokes —
 * `.update().set().where()` and `.insert().values()` — as thenables the drizzle
 * `await`/`yield*` resolves; nothing runs against a binding.
 */
function scriptedRun(rows: readonly Row[]): {
	run: DrizzleAccessOrDie["run"];
	updates: () => CapturedUpdate[];
	markerInserted: () => boolean;
} {
	const state = {i: 0};
	const updates: CapturedUpdate[] = [];
	let markerInserted = false;
	const resolved = () => Promise.resolve({results: []});
	const run = asRun(<A>(build: (db: DrizzleDb) => Promise<A>) => {
		const idx = state.i++;
		if (idx === 0) {
			const markerDb = asDb({
				query: {hotScoreBackfill: {findFirst: () => Promise.resolve(undefined)}},
			});
			return Effect.promise(() => build(markerDb));
		}
		if (idx === 1) return Effect.succeed(rows) as Effect.Effect<A>;
		const captureDb = asDb({
			update: () => ({
				set: (set: Record<string, unknown>) => ({
					where: () => {
						updates.push({set});
						return resolved();
					},
				}),
			}),
			insert: () => ({
				values: () => {
					markerInserted = true;
					return resolved();
				},
			}),
		});
		return Effect.promise(() => build(captureDb));
	});
	return {run, updates: () => updates, markerInserted: () => markerInserted};
}

describe("makeBackfillHotScores (#2131) — the windowless run-once hot_score backfill", () => {
	it.effect("recomputes a row 17 days OLD (outside the 72h window the cron scans)", () =>
		Effect.gen(function* () {
			const now = new Date("2026-07-05T12:00:00.000Z");
			const nowMs = now.getTime();
			// The exact pre-fix-frozen case: created 17 days ago, `hot_score` FROZEN at the
			// young age≈0 value — the row the windowed `refreshHotScores` never selects.
			const createdAt = new Date(nowMs - 17 * 24 * 3_600_000);
			const frozenYoung = computeHotScore(5, nowMs, nowMs);
			const scripted = scriptedRun([{id: "post_old", score: 5, hotScore: frozenYoung, createdAt}]);

			const result = yield* makeBackfillHotScores(scripted.run)(now);

			assert.strictEqual(result.ran, true, "the first pass runs");
			assert.strictEqual(result.scanned, 1, "the ancient row was scanned (not window-filtered)");
			assert.strictEqual(result.updated, 1, "its frozen score was re-decayed");

			// The emitted UPDATE carries the row's collapsed 17-day score — far below the
			// frozen young value, so the feed re-orders it down.
			const decayed = computeHotScore(5, createdAt.getTime(), nowMs);
			assert.isBelow(decayed, frozenYoung, "17-day decay collapses the frozen young score");
			const [update] = scripted.updates();
			assert.isDefined(update, "a hot_score UPDATE was issued for the ancient row");
			assert.strictEqual(
				update.set.hotScore,
				decayed,
				"the UPDATE writes the re-decayed hot_score",
			);

			// The run-once marker is stamped after the write-back.
			assert.isTrue(
				scripted.markerInserted(),
				"the hot_score_backfill marker row is inserted on completion",
			);
		}),
	);

	it.effect("is a run-once no-op once the marker row exists", () =>
		Effect.gen(function* () {
			const now = new Date("2026-07-05T12:00:00.000Z");
			let calls = 0;
			const run = asRun(<A>(build: (db: DrizzleDb) => Promise<A>) => {
				const idx = calls++;
				// The marker read returns a row ⇒ the backfill must short-circuit before any
				// select or write. A call past the marker read means the guard failed.
				if (idx === 0) {
					const markerDb = asDb({
						query: {hotScoreBackfill: {findFirst: () => Promise.resolve({id: 1})}},
					});
					return Effect.promise(() => build(markerDb));
				}
				return Effect.succeed([]) as Effect.Effect<A>;
			});

			const result = yield* makeBackfillHotScores(run)(now);

			assert.strictEqual(result.ran, false, "the marker present ⇒ no re-run");
			assert.strictEqual(result.scanned, 0, "no rows scanned on the no-op path");
			assert.strictEqual(result.updated, 0, "no writes on the no-op path");
			assert.strictEqual(
				calls,
				1,
				"only the marker read ran — no select/write after the short-circuit",
			);
		}),
	);
});
