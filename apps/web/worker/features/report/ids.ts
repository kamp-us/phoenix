/**
 * Report feature-local branded ids (epic #2700). The cross-feature polymorphic
 * `TargetId` (a report's post/definition/comment target) is imported read-only from
 * the shared `lib/ids.ts` (#2723/#2735); only the report-owned `ReportId` / `WaveId`
 * are minted here, feature-locally, so sibling slices don't append-conflict on the
 * shared module.
 *
 * Branding these distinctly from `TargetId` makes the moderation-flow triad
 * type-distinct: a report id, a wave-grouping id, and a target id can no longer be
 * transposed without a compile error, even though all three are plain strings at
 * runtime. See `../../lib/ids.ts` for the branding idiom (effect-smol `SCHEMA.md`
 * §Branding) — not re-derived here.
 */
import {brandedId} from "../../lib/ids.ts";

/** A `content_report` row id — one filed report. */
export const ReportId = brandedId("ReportId");
export type ReportId = typeof ReportId.Type;

/**
 * A remove-the-wave grouping id (#1855, ADR 0138): the client stamps ONE per wave
 * gesture and threads the same id through every fanned-out resolve, so the batch
 * reopens/restores as a unit. Distinct from `ReportId` — a wave groups many reports.
 */
export const WaveId = brandedId("WaveId");
export type WaveId = typeof WaveId.Type;
