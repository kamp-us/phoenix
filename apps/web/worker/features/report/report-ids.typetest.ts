/**
 * Type-level assertion (no runtime — checked by `tsgo`, not vitest): the moderation
 * id surfaces `ReportId` (a filed report), `WaveId` (a remove-the-wave grouping), and
 * the shared polymorphic `TargetId` (the report's post/definition/comment target) are
 * nominally distinct, so transposing any two is a compile error (#2721 AC#4), while all
 * three stay plain strings at runtime. Mirrors `../vote/vote-ids.typetest.ts`.
 */
import {expectTypeOf} from "vitest";
import type {TargetId} from "../../lib/ids.ts";
import type {ReportId, WaveId} from "./ids.ts";

// All three brands erase to `string` at runtime — the brand is type-only (#2735).
expectTypeOf<ReportId>().toMatchTypeOf<string>();
expectTypeOf<WaveId>().toMatchTypeOf<string>();
expectTypeOf<TargetId>().toMatchTypeOf<string>();

// The distinctness that makes a reportId/targetId/waveId swap unrepresentable: no brand
// is assignable to another, so a moderation flow can't confuse the three ids.
expectTypeOf<ReportId>().not.toEqualTypeOf<TargetId>();
expectTypeOf<ReportId>().not.toMatchTypeOf<TargetId>();
expectTypeOf<TargetId>().not.toMatchTypeOf<ReportId>();
expectTypeOf<ReportId>().not.toMatchTypeOf<WaveId>();
expectTypeOf<WaveId>().not.toMatchTypeOf<ReportId>();

declare const someReportId: ReportId;
declare const someTargetId: TargetId;

// The literal "a reportId/targetId swap fails pnpm typecheck" proof: were the two
// interchangeable, these `@ts-expect-error` directives would themselves fail as unused
// (TS2578).
// @ts-expect-error a TargetId cannot stand in for a ReportId — the report/target swap is a compile error
export const _targetAsReport: ReportId = someTargetId;
// @ts-expect-error a ReportId cannot stand in for a TargetId — the report/target swap is a compile error
export const _reportAsTarget: TargetId = someReportId;
