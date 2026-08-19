/**
 * Report-owned branded ids, minted feature-locally so sibling slices don't
 * append-conflict on the shared `lib/ids.ts`. Branding them distinctly from `TargetId`
 * is what makes transposing the moderation triad a compile error, even though all three
 * are plain strings at runtime.
 */
import {brandedId} from "../../lib/ids.ts";

export const ReportId = brandedId("ReportId");
export type ReportId = typeof ReportId.Type;

/**
 * A remove-the-wave grouping id (#1855): the client stamps ONE per wave gesture and
 * threads it through every fanned-out resolve, so the batch restores as a unit.
 */
export const WaveId = brandedId("WaveId");
export type WaveId = typeof WaveId.Type;
