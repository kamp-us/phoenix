/**
 * CaylakVisibility unit coverage — the decisions that are wrong-or-right with no
 * database (ADR 0082, the `Mute.unit.test.ts` idiom): the `Drizzle` seam is
 * substituted directly, so a counted `batch` proves an idempotent no-op never reached
 * the write and a throwing `run` proves a short-circuit never read.
 *
 * Real-D1 fidelity (the PK's one-row-per-account constraint, the delete round-trip)
 * lands at the integration tier once a surface exists to drive this black-box over.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb} from "../../db/Drizzle.ts";
import {CaylakVisibility, CaylakVisibilityLive} from "./CaylakVisibility.ts";

const OPTED_IN_AT = new Date("2026-08-19T00:00:00.000Z");

const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("wrote a batch on a path that must short-circuit")),
};

/** A `Drizzle` whose `run` replays queued probe results and whose `batch` is counted. */
function scriptedAccess(results: ReadonlyArray<unknown>) {
	const state = {reads: 0, writes: 0};
	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			void fn;
			return Effect.succeed(results[state.reads++] as A);
		},
		batch: () => {
			state.writes++;
			return Effect.succeed([] as never);
		},
	};
	return {access, state};
}

const layerFor = (access: DrizzleAccess) =>
	CaylakVisibilityLive.pipe(Layer.provide(Layer.succeed(Drizzle, access)));

describe("CaylakVisibility.read — presence is the preference", () => {
	it.effect("a missing account id is opted out with no read", () =>
		Effect.gen(function* () {
			const service = yield* CaylakVisibility;
			assert.deepStrictEqual(yield* service.read(null), {optedIn: false});
		}).pipe(Effect.provide(layerFor(throwingAccess))),
	);

	it.effect("no row is opted out; a row carries the set-at timestamp", () =>
		Effect.gen(function* () {
			const service = yield* CaylakVisibility;
			assert.deepStrictEqual(yield* service.read("u1"), {optedIn: false});
			assert.deepStrictEqual(yield* service.read("u1"), {optedIn: true, setAt: OPTED_IN_AT});
		}).pipe(Effect.provide(layerFor(scriptedAccess([undefined, {setAt: OPTED_IN_AT}]).access))),
	);
});

describe("CaylakVisibility.set — idempotent probe-then-write", () => {
	it.effect("opting in when already opted in writes nothing and keeps the original set-at", () => {
		const scripted = scriptedAccess([{setAt: OPTED_IN_AT}]);
		return Effect.gen(function* () {
			const service = yield* CaylakVisibility;
			const result = yield* service.set({userId: "u1", value: true});
			assert.deepStrictEqual(result, {optedIn: true, setAt: OPTED_IN_AT, changed: false});
			assert.strictEqual(scripted.state.writes, 0, "an idempotent opt-in writes nothing");
		}).pipe(Effect.provide(layerFor(scripted.access)));
	});

	it.effect("opting out when never opted in writes nothing", () => {
		const scripted = scriptedAccess([undefined]);
		return Effect.gen(function* () {
			const service = yield* CaylakVisibility;
			const result = yield* service.set({userId: "u1", value: false});
			assert.deepStrictEqual(result, {optedIn: false, changed: false});
			assert.strictEqual(scripted.state.writes, 0, "an idempotent opt-out writes nothing");
		}).pipe(Effect.provide(layerFor(scripted.access)));
	});

	it.effect("a real opt-in writes once and reports the new state", () => {
		const scripted = scriptedAccess([undefined]);
		return Effect.gen(function* () {
			const service = yield* CaylakVisibility;
			const result = yield* service.set({userId: "u1", value: true});
			assert.strictEqual(result.optedIn, true);
			assert.strictEqual(result.changed, true);
			assert.strictEqual(scripted.state.writes, 1);
		}).pipe(Effect.provide(layerFor(scripted.access)));
	});

	it.effect("a real opt-out writes once and drops the timestamp", () => {
		const scripted = scriptedAccess([{setAt: OPTED_IN_AT}]);
		return Effect.gen(function* () {
			const service = yield* CaylakVisibility;
			const result = yield* service.set({userId: "u1", value: false});
			assert.deepStrictEqual(result, {optedIn: false, changed: true});
			assert.strictEqual(scripted.state.writes, 1);
		}).pipe(Effect.provide(layerFor(scripted.access)));
	});
});
