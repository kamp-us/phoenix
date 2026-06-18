/**
 * Report mutation resolver — the `report.submit` write path over the polymorphic
 * `Report` service. `CurrentUser.required` gates it (anonymous → `UNAUTHORIZED`);
 * the handler calls `Report.submit` and returns a `ReportReceipt` ack, NOT a
 * re-resolved entity (a report has no public read view — ADR 0082). Because the
 * ack is returned inline (the interpreter stamps `__typename` only on
 * source-resolved entities), the handler shapes it through `toReportReceipt` so the
 * receipt carries its discriminant like every other fate entity.
 *
 * The service raises `ReportTargetNotFound` (no wire `ErrorCode`); this boundary
 * translates it into the per-feature not-found by `targetKind` so the wire only
 * emits feature-level errors — the same translation the vote mutations apply to
 * `VoteTargetNotFound`. See `.patterns/fate-effect-operations.md`.
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {CommentNotFound, PostNotFound} from "../pano/errors.ts";
import {DefinitionNotFound} from "../sozluk/errors.ts";
import type {ReportTargetNotFound} from "./errors.ts";
import {Report} from "./Report.ts";
import {toReportReceipt} from "./shapers.ts";
import {ReportReceiptView} from "./views.ts";

const SubmitReportInput = Schema.Struct({
	targetKind: Schema.Literals(["definition", "post", "comment"]),
	targetId: Schema.String,
	reason: Schema.optional(Schema.NullOr(Schema.String)),
});

// Translate the service's kind-blind not-found into the feature-level error its
// `targetKind` names — the wire-facing not-found the client already knows.
const toFeatureNotFound = (e: ReportTargetNotFound) => {
	switch (e.targetKind) {
		case "post":
			return new PostNotFound({postId: e.targetId, message: e.message});
		case "comment":
			return new CommentNotFound({commentId: e.targetId, message: e.message});
		case "definition":
			return new DefinitionNotFound({definitionId: e.targetId, message: e.message});
	}
};

export const mutations = {
	"report.submit": Fate.mutation(
		{
			input: SubmitReportInput,
			type: ReportReceiptView,
			error: Schema.Union([Unauthorized, PostNotFound, CommentNotFound, DefinitionNotFound]),
		},
		Effect.fn("report.submit")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const report = yield* Report;
			const result = yield* report
				.submit({
					reporterId: user.id,
					targetKind: input.targetKind,
					targetId: input.targetId,
					reason: input.reason ?? null,
				})
				.pipe(
					Effect.catchTag("report/ReportTargetNotFound", (e) => Effect.fail(toFeatureNotFound(e))),
				);
			return toReportReceipt(result);
		}),
	),
};
