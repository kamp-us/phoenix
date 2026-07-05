/**
 * The fixed positional Analytics Engine event-schema (ADR 0153 §"The event-schema
 * convention") — the single owner of the `TelemetryEvent -> DataPoint` mapping.
 *
 * AE columns are POSITIONAL (`index1`, `blob1..`, `double1..`; no named schema),
 * so fields must be written in identical order across every event or columns
 * misalign SILENTLY. The `toDataPoint` map below is therefore the ONE place any
 * field lands in a slot — a second mapping site is the exact failure mode this
 * module exists to prevent. The fixed layout:
 *
 *   indexes: [feature]                          — the one sampling/grouping key
 *   blobs:   [feature, action, surface, userId?] — string dimensions
 *   doubles: [1]                                 — the count
 *
 * `TelemetryEvent` is a CLOSED discriminated union on `feature` (make-invalid-
 * states-unrepresentable): the members are the per-feature event shapes, each
 * carrying its typed fields — no open string bag. Event vocabulary is English/
 * technical (glossary rule — telemetry is not product-facing copy).
 */
import type * as Cloudflare from "alchemy/Cloudflare";

/** The `vote` product-usage event (the karma-bearing ranking signal). */
export interface VoteEvent {
	readonly feature: "vote";
	readonly action: string;
	readonly surface: string;
	readonly userId?: string;
}

/** The `reaction` product-usage event (the karma-free social signal). */
export interface ReactionEvent {
	readonly feature: "reaction";
	readonly action: string;
	readonly surface: string;
	readonly userId?: string;
}

/**
 * The closed telemetry event union. A non-member `feature` is a compile error —
 * every instrument emits one of these shapes, never a raw data point (ADR 0153).
 */
export type TelemetryEvent = VoteEvent | ReactionEvent;

/**
 * The single positional `TelemetryEvent -> DataPoint` map. `userId` is a
 * deliberately-approximate blob (ADR 0153 — distinct-user counts are estimates
 * under sampling), so it is the last, optional blob and is omitted when absent
 * rather than emitted as an empty slot that would shift no other column.
 */
export function toDataPoint(event: TelemetryEvent): Cloudflare.AnalyticsEngine.DataPoint {
	const blobs = [event.feature, event.action, event.surface];
	if (event.userId !== undefined) blobs.push(event.userId);
	return {
		indexes: [event.feature],
		blobs,
		doubles: [1],
	};
}
