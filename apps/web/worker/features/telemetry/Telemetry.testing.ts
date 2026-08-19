/**
 * `Telemetry` test doubles (ADR 0153). The pinned invariant: a telemetry failure never
 * fails the mutation it observes.
 */
import {Effect, Layer} from "effect";
import type {TelemetryEvent} from "./schema.ts";
import {Telemetry} from "./Telemetry.ts";

export const recordingTelemetry = (sink: TelemetryEvent[]) =>
	Layer.succeed(Telemetry, {
		emit: (event) => {
			sink.push(event);
			return Effect.void;
		},
	} satisfies typeof Telemetry.Service);

/**
 * A real `emit` never fails (its channels are discharged in `TelemetryLive`); this double
 * deliberately breaks that to prove an instrument's commit is sequenced BEFORE the emit.
 */
export const dyingTelemetry = Layer.succeed(Telemetry, {
	emit: () => Effect.die(new Error("telemetry emit must never fail the mutation it observes")),
} satisfies typeof Telemetry.Service);
