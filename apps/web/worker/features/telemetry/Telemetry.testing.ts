/**
 * `Telemetry` test doubles for the instruments that emit through the seam (the
 * `Reaction.react`/`Vote.cast` reference instruments, ADR 0153 / #2068 / #2069).
 * An instrument's unit test substitutes the `Telemetry` tag directly
 * (`.patterns/effect-testing.md`) to assert WHICH event it emits, and to pin the
 * fail-safe (S4) — a telemetry failure never fails the mutation it observes.
 *
 *   - {@link recordingTelemetry} records every emitted event so a test asserts the
 *     exact `{feature, action, surface, emoji?}` shape (and its absence on a no-op).
 *   - {@link dyingTelemetry} makes `emit` DIE, so a test proves the instrument's
 *     write already committed before the (best-effort) emit — the emit is off the
 *     commit path. The production fail-safe (the `DatasetError` swallow) lives in
 *     `TelemetryLive` and is pinned in `Telemetry.unit.test.ts`; this double lets an
 *     instrument test show the emit's failure mode can't unwind the mutation.
 */
import {Effect, Layer} from "effect";
import type {TelemetryEvent} from "./schema.ts";
import {Telemetry} from "./Telemetry.ts";

/**
 * A `Telemetry` whose `emit` records each event into `sink` and succeeds — the
 * recording double for asserting an instrument emitted the expected event (or, by
 * an empty `sink`, that it emitted nothing on a no-op).
 */
export const recordingTelemetry = (sink: TelemetryEvent[]) =>
	Layer.succeed(Telemetry, {
		emit: (event) => {
			sink.push(event);
			return Effect.void;
		},
	} satisfies typeof Telemetry.Service);

/**
 * A `Telemetry` whose `emit` DIES — the misbehaving-emit double. `emit`'s
 * production type is `Effect<void>` (its channels are discharged in
 * `TelemetryLive`), so a real emit never fails; this double deliberately breaks
 * that to prove an instrument's commit is sequenced BEFORE the emit and is not
 * unwound by an emit that blows up.
 */
export const dyingTelemetry = Layer.succeed(Telemetry, {
	emit: () => Effect.die(new Error("telemetry emit must never fail the mutation it observes")),
} satisfies typeof Telemetry.Service);
