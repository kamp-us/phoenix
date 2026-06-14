/**
 * Tagged errors raised by the Report service layer.
 *
 * `ReportTargetNotFound` carries NO `ErrorCode` by design: it never reaches the
 * wire. The `report.submit` mutation (next epic-#82 child) translates it at its
 * own boundary via `Effect.catchTag` into the feature-level not-found wire error,
 * exactly as the vote mutations translate `VoteTargetNotFound`.
 */
import * as Schema from "effect/Schema";

// Lives here, not in `Report.ts`, to keep the `Report.ts → errors.ts` edge
// one-way: the reverse direction is a cycle tsgo refuses to resolve even with
// `import type` (the `vote/errors.ts` precedent).
export type ReportTargetKind = "definition" | "post" | "comment";

export class ReportTargetNotFound extends Schema.TaggedErrorClass<ReportTargetNotFound>()(
	"report/ReportTargetNotFound",
	{
		targetKind: Schema.Literals(["definition", "post", "comment"]),
		targetId: Schema.String,
		message: Schema.String,
	},
) {}
