/**
 * `Telemetry` unit coverage (ADR 0153, #2067) — the decisions that are wrong-or-
 * right with no database and no real Analytics Engine (ADR 0082). Two facts:
 *
 *   1. the fixed positional `TelemetryEvent -> DataPoint` map (`toDataPoint`)
 *      lands each field in its exact slot — the guard against the silent
 *      column-misalignment failure AE's positional schema makes possible;
 *   2. the fail-safe (S4) invariant — a `DatasetError` from the underlying write
 *      client is discharged INSIDE `TelemetryLive`, so `emit` still succeeds
 *      (`Effect.void`) and never surfaces an error to its caller.
 *
 * The AE client seam is substituted directly at the `TelemetryClient` tag
 * (`.patterns/effect-testing.md`): a recording client to inspect the mapped data
 * point, and a failing client to prove the swallow. No real AE, and the emit path
 * carries no `R` (both channels discharged in the layer), so both run at the
 * `unit` tier.
 */
import {assert, describe, it} from "@effect/vitest";
import {RuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {Effect, Exit, Layer} from "effect";
import {toDataPoint} from "./schema.ts";
import {Telemetry, TelemetryClient, TelemetryLive} from "./Telemetry.ts";

// An inert `RuntimeContext` — the ambient context `writeDataPoint` needs, captured
// by the layer at build. The substitute clients below ignore it, so a stub with
// no-op accessors is enough to build the layer.
const inertRuntimeContext = Layer.succeed(RuntimeContext)({
	Type: "telemetry-test",
	id: "telemetry-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id: string) => Effect.succeed(id),
});

// A `TelemetryClient` whose `writeDataPoint` records the mapped data point — so a
// test can assert the exact `{indexes, blobs, doubles}` `emit` produced.
const recordingClient = (sink: Cloudflare.AnalyticsEngine.DataPoint[]) =>
	Layer.succeed(TelemetryClient)(
		TelemetryClient.of({
			raw: Effect.die(new Error("raw unused")),
			writeDataPoint: (dp) => {
				sink.push(dp);
				return Effect.void;
			},
		}),
	);

// A `TelemetryClient` whose `writeDataPoint` always fails with a `DatasetError` —
// drives the S4 fail-safe proof: `emit` must still succeed.
const failingClient = Layer.succeed(TelemetryClient)(
	TelemetryClient.of({
		raw: Effect.die(new Error("raw unused")),
		writeDataPoint: () =>
			Effect.fail(
				new Cloudflare.AnalyticsEngine.DatasetError({
					message: "AE write failed",
					cause: new Error("boom"),
				}),
			),
	}),
);

// A `TelemetryClient` whose `writeDataPoint` DIES (a defect, not a typed error) —
// drives the seam-contains-a-defect proof (#2085): `emit` must still succeed even
// though a defect slipped into the emit path, because the seam swallows the whole
// Cause (`Effect.ignoreCause`), not just the typed `E` (`Effect.ignore`).
const dyingClient = Layer.succeed(TelemetryClient)(
	TelemetryClient.of({
		raw: Effect.die(new Error("raw unused")),
		writeDataPoint: () => Effect.die(new Error("writeDataPoint blew up")),
	}),
);

describe("toDataPoint — fixed positional AE schema (ADR 0153)", () => {
	it("maps a vote event to the fixed slot order (index=feature, blobs, doubles=[1])", () => {
		assert.deepStrictEqual(
			toDataPoint({feature: "vote", action: "cast", surface: "pano", userId: "u1"}),
			{indexes: ["vote"], blobs: ["vote", "cast", "pano", "u1"], doubles: [1]},
		);
	});

	it("omits the optional userId blob when absent (no empty slot that shifts no column)", () => {
		assert.deepStrictEqual(toDataPoint({feature: "reaction", action: "react", surface: "sozluk"}), {
			indexes: ["reaction"],
			blobs: ["reaction", "react", "sozluk"],
			doubles: [1],
		});
	});

	it("maps a reaction's emoji to the trailing blob slot after userId (#2069)", () => {
		assert.deepStrictEqual(
			toDataPoint({
				feature: "reaction",
				action: "react",
				surface: "post",
				userId: "u1",
				emoji: "❤️",
			}),
			{indexes: ["reaction"], blobs: ["reaction", "react", "post", "u1", "❤️"], doubles: [1]},
		);
	});

	it("a retract carries no emoji — the trailing slot is dropped, userId stays at blob4", () => {
		assert.deepStrictEqual(
			toDataPoint({feature: "reaction", action: "retract", surface: "comment", userId: "u1"}),
			{indexes: ["reaction"], blobs: ["reaction", "retract", "comment", "u1"], doubles: [1]},
		);
	});

	it("keeps emoji at blob5 even with an absent userId — an empty placeholder holds blob4", () => {
		// The positional-stability guard: a present emoji with no userId must NOT slide
		// into blob4, or the column silently misaligns. userId is filled with "" so emoji
		// stays at its fixed slot.
		assert.deepStrictEqual(
			toDataPoint({feature: "reaction", action: "react", surface: "post", emoji: "🔥"}),
			{
				indexes: ["reaction"],
				blobs: ["reaction", "react", "post", "", "🔥"],
				doubles: [1],
			},
		);
	});
});

describe("Telemetry.emit", () => {
	it("emits the positionally-mapped data point through the write client", () => {
		const sink: Cloudflare.AnalyticsEngine.DataPoint[] = [];
		return Effect.gen(function* () {
			const telemetry = yield* Telemetry;
			yield* telemetry.emit({feature: "vote", action: "cast", surface: "pano", userId: "u1"});
			assert.strictEqual(sink.length, 1);
			assert.deepStrictEqual(sink[0], {
				indexes: ["vote"],
				blobs: ["vote", "cast", "pano", "u1"],
				doubles: [1],
			});
		}).pipe(
			Effect.provide(
				TelemetryLive.pipe(
					Layer.provide(Layer.mergeAll(recordingClient(sink), inertRuntimeContext)),
				),
			),
		);
	});

	it("swallows a DatasetError — emit still succeeds, never fails the caller (S4)", () =>
		Effect.gen(function* () {
			const telemetry = yield* Telemetry;
			const exit = yield* Effect.exit(
				telemetry.emit({feature: "reaction", action: "react", surface: "sozluk"}),
			);
			assert.strictEqual(Exit.isSuccess(exit), true);
		}).pipe(
			Effect.provide(
				TelemetryLive.pipe(Layer.provide(Layer.mergeAll(failingClient, inertRuntimeContext))),
			),
		));

	it("contains a DEFECT in the write path — emit still succeeds (seam-level S4, #2085)", () =>
		// The whole point of moving containment into the seam: a defect (a die, a sync
		// throw) inside emit must NOT propagate to the caller. `Effect.ignore` would let
		// this exit die; `Effect.ignoreCause` swallows the whole Cause, so emit succeeds.
		Effect.gen(function* () {
			const telemetry = yield* Telemetry;
			const exit = yield* Effect.exit(
				telemetry.emit({feature: "reaction", action: "react", surface: "sozluk"}),
			);
			assert.strictEqual(Exit.isSuccess(exit), true);
		}).pipe(
			Effect.provide(
				TelemetryLive.pipe(Layer.provide(Layer.mergeAll(dyingClient, inertRuntimeContext))),
			),
		));
});
