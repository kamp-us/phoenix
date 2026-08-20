/**
 * Report unit coverage — the decisions that are wrong-or-right with no database
 * (ADR 0082). A `run` that THROWS proves a short-circuit never touched the DB.
 *
 * Report has no fate/HTTP surface yet, so the engine-fidelity assertions (real D1's
 * `changes === 0` on the composite-PK `onConflictDoNothing`, `deletedAt IS NULL`
 * filtering a soft-deleted row) have nowhere integration-reachable to live and move
 * to real D1 once `report.submit` lands.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {
	createDrizzle,
	Drizzle,
	type DrizzleAccess,
	type DrizzleDb,
	DrizzleError,
} from "../../db/Drizzle.ts";
import {Report, ReportLive} from "./Report.ts";

const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Report read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Report wrote a batch on a path that must short-circuit")),
};

// Replays a queued sequence of `run` results (each is the queued value, returned
// verbatim — the callback is never invoked, so no engine is needed).
function scriptedAccess(results: ReadonlyArray<unknown>): DrizzleAccess {
	const state = {i: 0};
	return {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("Report.submit issues no batch")),
	};
}

const reportLayer = (access: DrizzleAccess) =>
	ReportLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

// The REAL write path renders against this fake D1, so the captured `{sql, params}` is
// the actual statement the service issues (#1855).
function capturingDrizzle(): {
	access: DrizzleAccess;
	captured: Array<{sql: string; params: unknown[]}>;
} {
	const captured: Array<{sql: string; params: unknown[]}> = [];
	// biome-ignore lint/plugin: a capturing D1 stub — only prepare/bind/run are exercised to record the rendered statement; nothing executes against a binding.
	const fakeD1 = {
		prepare(sql: string) {
			const stmt = {
				bind(...params: unknown[]) {
					captured.push({sql, params});
					return stmt;
				},
				run: async () => ({success: true, meta: {changes: 1}, results: []}),
				all: async () => ({success: true, meta: {changes: 0}, results: []}),
				first: async () => null,
				raw: async () => [],
			};
			return stmt;
		},
	} as unknown as D1Database;
	const db = createDrizzle(fakeD1);
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) =>
			Effect.tryPromise({try: () => fn(db), catch: (cause) => new DrizzleError({cause})}),
		batch: () => Effect.die(new Error("wave writes issue no batch")),
	};
	return {access, captured};
}

describe("Report.readByReporter — no-read short-circuit (mocked Drizzle seam)", () => {
	it.effect("empty ids → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const reported = yield* report.readByReporter("u1", "definition", []);
			assert.strictEqual(reported.size, 0);
		}).pipe(Effect.provide(reportLayer(throwingAccess))),
	);

	it.effect("null viewer → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const reported = yield* report.readByReporter(null, "definition", ["def-1"]);
			assert.strictEqual(reported.size, 0);
		}).pipe(Effect.provide(reportLayer(throwingAccess))),
	);

	it.effect("undefined viewer → empty Set without touching the DB", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const reported = yield* report.readByReporter(undefined, "definition", ["def-1"]);
			assert.strictEqual(reported.size, 0);
		}).pipe(Effect.provide(reportLayer(throwingAccess))),
	);
});

describe("Report.submit — target-liveness decision (mocked Drizzle seam)", () => {
	it.effect("a missing target raises ReportTargetNotFound before the insert", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const exit = yield* Effect.exit(
				report.submit({reporterId: "r1", targetKind: "post", targetId: "ghost"}),
			);
			assert.isTrue(exit._tag === "Failure", "submit against a missing target fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /ReportTargetNotFound/);
		}).pipe(Effect.provide(reportLayer(scriptedAccess([undefined])))),
	);

	it.effect("a soft-deleted target reads as absent → ReportTargetNotFound", () =>
		// The predicate itself is the engine's job; the DECISION under test is that a
		// presence read returning nothing means not-found.
		Effect.gen(function* () {
			const report = yield* Report;
			const exit = yield* Effect.exit(
				report.submit({reporterId: "r1", targetKind: "definition", targetId: "def-gone"}),
			);
			assert.isTrue(exit._tag === "Failure", "submit against a soft-deleted target fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /ReportTargetNotFound/);
		}).pipe(Effect.provide(reportLayer(scriptedAccess([undefined])))),
	);
});

describe("Report.listResolved — row→group mapping decision (mocked Drizzle seam)", () => {
	it.effect(
		"maps each aggregate row to a ResolvedReportGroup (seconds→Date, Number coercions)",
		() =>
			// The engine's GROUP BY / ORDER BY is integration-tier; what is under test is
			// the pure row→group shape.
			Effect.gen(function* () {
				const report = yield* Report;
				const groups = yield* report.listResolved({limit: 10});
				assert.strictEqual(groups.length, 2);
				assert.deepStrictEqual(
					{
						targetKind: groups[0]?.targetKind,
						targetId: groups[0]?.targetId,
						resolution: groups[0]?.resolution,
						resolverId: groups[0]?.resolverId,
						reportCount: groups[0]?.reportCount,
						resolvedAtMs: groups[0]?.resolvedAt.getTime(),
					},
					{
						targetKind: "post",
						targetId: "p-1",
						resolution: "removed",
						resolverId: "mod-a",
						reportCount: 3,
						// 1_767_000_000 seconds → ms
						resolvedAtMs: 1_767_000_000_000,
					},
				);
				assert.strictEqual(groups[1]?.resolution, "dismissed");
			}).pipe(
				Effect.provide(
					reportLayer(
						scriptedAccess([
							[
								{
									targetKind: "post",
									targetId: "p-1",
									reportCount: 3,
									resolvedAt: 1_767_000_000,
									resolverId: "mod-a",
									resolution: "removed",
								},
								{
									targetKind: "definition",
									targetId: "d-2",
									reportCount: 1,
									resolvedAt: 1_766_000_000,
									resolverId: "mod-b",
									resolution: "dismissed",
								},
							],
						]),
					),
				),
			),
	);

	it.effect("empty result → empty array", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const groups = yield* report.listResolved();
			assert.strictEqual(groups.length, 0);
		}).pipe(Effect.provide(reportLayer(scriptedAccess([[]])))),
	);
});

describe("Report.submit — created/no-op decision maps meta.changes (mocked Drizzle seam)", () => {
	it.effect("changes > 0 → created", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const result = yield* report.submit({
				reporterId: "r1",
				targetKind: "definition",
				targetId: "def-1",
				reason: "spam",
			});
			assert.isTrue(result.created, "a landed insert is created");
			assert.strictEqual(result.targetId, "def-1");
		}).pipe(Effect.provide(reportLayer(scriptedAccess([{id: "def-1"}, {meta: {changes: 1}}])))),
	);

	it.effect("changes === 0 (composite-PK conflict swallowed) → idempotent no-op", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const result = yield* report.submit({
				reporterId: "r1",
				targetKind: "definition",
				targetId: "def-1",
			});
			assert.isFalse(result.created, "a swallowed PK conflict is a no-op success");
		}).pipe(Effect.provide(reportLayer(scriptedAccess([{id: "def-1"}, {meta: {changes: 0}}])))),
	);
});

// A wave-remove must write ONE grouping identity that restores as a unit (#1855).
describe("Report.resolveTarget — wave grouping stamp (#1855, captured render)", () => {
	it.effect("a resolve carrying a waveId stamps wave_id with that shared id (batch)", () =>
		Effect.gen(function* () {
			const {access, captured} = capturingDrizzle();
			yield* Effect.provide(
				Effect.gen(function* () {
					const report = yield* Report;
					yield* report.resolveTarget({
						targetKind: "post",
						targetId: "p1",
						resolverId: "mod",
						action: "dismiss",
						resolvedAt: new Date("2026-01-01T00:00:00Z"),
						waveId: "wave-1",
					});
				}),
				reportLayer(access),
			);
			const upd = captured.find((c) => /update\b/i.test(c.sql) && /content_report/i.test(c.sql));
			assert.isDefined(upd, "the resolve issued an UPDATE on content_report");
			assert.match(upd!.sql, /"wave_id"\s*=\s*\?/i, "the UPDATE sets wave_id");
			assert.include(upd!.params, "wave-1", "wave_id is bound to the shared wave id");
		}),
	);

	it.effect("a single-target resolve (no waveId) leaves wave_id null", () =>
		Effect.gen(function* () {
			const {access, captured} = capturingDrizzle();
			yield* Effect.provide(
				Effect.gen(function* () {
					const report = yield* Report;
					yield* report.resolveTarget({
						targetKind: "post",
						targetId: "p1",
						resolverId: "mod",
						action: "dismiss",
						resolvedAt: new Date("2026-01-01T00:00:00Z"),
					});
				}),
				reportLayer(access),
			);
			const upd = captured.find((c) => /update\b/i.test(c.sql) && /content_report/i.test(c.sql));
			assert.isDefined(upd, "the resolve issued an UPDATE on content_report");
			assert.match(upd!.sql, /"wave_id"\s*=\s*\?/i, "the UPDATE still sets wave_id (explicitly)");
			assert.include(upd!.params, null, "wave_id is bound null on a lone resolve");
			assert.notInclude(upd!.params, "wave-1", "no wave grouping leaks onto a single resolve");
		}),
	);
});

describe("Report.reopenForWave — restore the batch as a unit (#1855, captured render)", () => {
	it.effect("reopens exactly the rows sharing the waveId, and nothing else", () =>
		Effect.gen(function* () {
			const {access, captured} = capturingDrizzle();
			const {reopened} = yield* Effect.provide(
				Effect.gen(function* () {
					const report = yield* Report;
					return yield* report.reopenForWave("wave-1");
				}),
				reportLayer(access),
			);
			assert.strictEqual(reopened, 1, "the fake render reports the rows the WHERE matched");
			const upd = captured.find((c) => /update\b/i.test(c.sql) && /content_report/i.test(c.sql));
			assert.isDefined(upd, "reopenForWave issued an UPDATE on content_report");
			// Scoped by the wave grouping — the batch, nothing outside it.
			assert.match(upd!.sql, /where[\s\S]*"wave_id"\s*=\s*\?/i, "the WHERE filters by wave_id");
			assert.include(upd!.params, "wave-1", "the WHERE binds the batch's wave id");
			// Reopened back to a pristine open row — status flipped, grouping cleared.
			assert.match(upd!.sql, /set[\s\S]*"status"\s*=\s*\?/i, "it flips status back to open");
			assert.include(upd!.params, "open", "status is set to open");
			assert.include(upd!.params, "resolved", "it targets resolved rows");
			assert.include(upd!.params, "dismissed", "and dismissed rows");
		}),
	);
});

describe("Report.listResolved — wave grouping id maps onto the group (#1855, mocked seam)", () => {
	it.effect("MIN(wave_id) passes through: a wave row carries its id, a lone row null", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const groups = yield* report.listResolved();
			assert.strictEqual(groups[0]?.waveId, "wave-1", "a wave-removal group carries its shared id");
			assert.strictEqual(groups[1]?.waveId, null, "a lone removal group has no wave grouping");
		}).pipe(
			Effect.provide(
				reportLayer(
					scriptedAccess([
						[
							{
								targetKind: "post",
								targetId: "p-1",
								reportCount: 1,
								resolvedAt: 1_767_000_000,
								resolverId: "mod-a",
								resolution: "removed",
								waveId: "wave-1",
							},
							{
								targetKind: "comment",
								targetId: "c-2",
								reportCount: 1,
								resolvedAt: 1_766_000_000,
								resolverId: "mod-a",
								resolution: "removed",
								waveId: null,
							},
						],
					]),
				),
			),
		),
	);
});

describe("Report.waveTargets — the batch's distinct targets (#1855)", () => {
	it.effect("maps each distinct row to a {targetKind, targetId}", () =>
		Effect.gen(function* () {
			const report = yield* Report;
			const targets = yield* report.waveTargets("wave-1");
			assert.deepStrictEqual(targets, [
				{targetKind: "post", targetId: "p-1"},
				{targetKind: "definition", targetId: "d-2"},
			]);
		}).pipe(
			Effect.provide(
				reportLayer(
					scriptedAccess([
						[
							{targetKind: "post", targetId: "p-1"},
							{targetKind: "definition", targetId: "d-2"},
						],
					]),
				),
			),
		),
	);

	it.effect("filters by the waveId and the terminal statuses (captured WHERE)", () =>
		Effect.gen(function* () {
			const {access, captured} = capturingDrizzle();
			yield* Effect.provide(
				Effect.gen(function* () {
					const report = yield* Report;
					return yield* report.waveTargets("wave-1");
				}),
				reportLayer(access),
			);
			const sel = captured.find((c) => /select/i.test(c.sql) && /content_report/i.test(c.sql));
			assert.isDefined(sel, "waveTargets issued a SELECT on content_report");
			assert.match(sel!.sql, /distinct/i, "it reads DISTINCT targets");
			assert.match(sel!.sql, /"wave_id"\s*=\s*\?/i, "scoped to the wave grouping");
			assert.include(sel!.params, "wave-1", "the WHERE binds the batch's wave id");
			assert.include(sel!.params, "resolved", "it reads resolved rows");
			assert.include(sel!.params, "dismissed", "and dismissed rows");
		}),
	);
});
