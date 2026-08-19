/**
 * The fixed positional Analytics Engine event-schema (ADR 0153) — the single owner of the
 * `TelemetryEvent -> DataPoint` mapping.
 *
 * AE columns are POSITIONAL (`index1`, `blob1..`, `double1..`; no named schema), so fields
 * written in a different order misalign columns SILENTLY. A second mapping site is the
 * exact failure mode this module exists to prevent. The fixed layout:
 *
 *   indexes: [feature]                                  — the one sampling/grouping key
 *   blobs:   [feature, action, surface, userId?, emoji?] — string dimensions
 *   doubles: [1]                                        — the count
 */
import type * as Cloudflare from "alchemy/Cloudflare";

export interface VoteEvent {
	readonly feature: "vote";
	readonly action: string;
	readonly surface: string;
	readonly userId?: string;
}

/**
 * The `reaction` event. `emoji` rides the trailing blob slot after `userId`; a `retract`
 * has none, so it is optional (see {@link toDataPoint} for the alignment rule).
 */
export interface ReactionEvent {
	readonly feature: "reaction";
	readonly action: string;
	readonly surface: string;
	readonly userId?: string;
	readonly emoji?: string;
}

/** The closed event union: a non-member `feature` is a compile error. */
export type TelemetryEvent = VoteEvent | ReactionEvent;

/**
 * `userId` and `emoji` are optional but land at FIXED slots (blob4, blob5). A trailing
 * optional is dropped when absent, so a present `emoji` with an absent `userId` fills
 * userId with an empty placeholder — otherwise `emoji` slides into blob4 and misaligns.
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
