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
 *   indexes: [feature]                                 — the one sampling/grouping key
 *   blobs:   [feature, action, surface, userId?, emoji?] — string dimensions
 *   doubles: [1]                                        — the count
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

/**
 * The `reaction` product-usage event (the karma-free social signal). Carries the
 * chosen `emoji` — the one dimension a reaction has over a vote (ADR 0153
 * §"First instrument": `Reaction.* emits {feature, action, surface, emoji}`). It
 * rides the trailing blob slot after `userId`; a `retract` has no emoji, so the
 * field is optional and omitted then (see {@link toDataPoint} for the positional
 * rule that keeps it aligned).
 */
export interface ReactionEvent {
	readonly feature: "reaction";
	readonly action: string;
	readonly surface: string;
	readonly userId?: string;
	readonly emoji?: string;
}

/**
 * The closed telemetry event union. A non-member `feature` is a compile error —
 * every instrument emits one of these shapes, never a raw data point (ADR 0153).
 */
export type TelemetryEvent = VoteEvent | ReactionEvent;

/**
 * The single positional `TelemetryEvent -> DataPoint` map. `userId` is a
 * deliberately-approximate blob (ADR 0153 — distinct-user counts are estimates
 * under sampling); `emoji` is the reaction-only trailing dimension (absent on a
 * `vote` and on a reaction `retract`). Both are optional and land at FIXED slots
 * (userId=blob4, emoji=blob5): a trailing optional is dropped when absent, but a
 * present `emoji` with an absent `userId` fills userId with an empty placeholder
 * so `emoji` never slides into blob4 and misaligns the column — the exact silent
 * misalignment this single mapping site exists to prevent.
 */
export function toDataPoint(event: TelemetryEvent): Cloudflare.AnalyticsEngine.DataPoint {
	const emoji = event.feature === "reaction" ? event.emoji : undefined;
	const blobs = [event.feature, event.action, event.surface];
	if (event.userId !== undefined || emoji !== undefined) blobs.push(event.userId ?? "");
	if (emoji !== undefined) blobs.push(emoji);
	return {
		indexes: [event.feature],
		blobs,
		doubles: [1],
	};
}
