/**
 * Report unit coverage — the decisions that are wrong-or-right with no database
 * (ADR 0082). The `Drizzle` seam is substituted directly (`Drizzle.test.ts`
 * half-A idiom): a `run` that THROWS proves a short-circuit never touched the
 * DB; a stubbed `run` feeds `assertTargetLive`'s presence read and the insert's
 * `meta.changes` envelope to the decision without an engine.
 *
 * Report has no fate/HTTP surface yet (`report.submit` is a future epic-#82
 * child — see `report/errors.ts`), so the engine-fidelity assertions the old
 * faked-engine suite ran — that real D1 actually returns `changes === 0`
 * on the composite-PK `onConflictDoNothing`, and that `deletedAt IS NULL`
 * filters a soft-deleted row — have no integration-reachable surface and move to
 * real D1 once that mutation lands (tracked follow-up). What is testable today is
 * the pure decision layer over a mocked seam: which `meta.changes` value maps to
 * `created`, and which presence read maps to `ReportTargetNotFound`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
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
			// assertTargetLive's presence read resolves `undefined` → not-found.
			const exit = yield* Effect.exit(
				report.submit({reporterId: "r1", targetKind: "post", targetId: "ghost"}),
			);
			assert.isTrue(exit._tag === "Failure", "submit against a missing target fails");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /ReportTargetNotFound/);
		}).pipe(Effect.provide(reportLayer(scriptedAccess([undefined])))),
	);

	it.effect("a soft-deleted target reads as absent → ReportTargetNotFound", () =>
		// The `deletedAt IS NULL` predicate is the engine's job (integration, once a
		// surface exists); the DECISION is: a presence read that returns nothing →
		// not-found. Modeling the filtered row as absent (`undefined`) proves it.
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

describe("Report.submit — created/no-op decision maps meta.changes (mocked Drizzle seam)", () => {
	it.effect("changes > 0 → created", () =>
		// run #1 assertTargetLive → a live row; run #2 the insert → its meta envelope.
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
