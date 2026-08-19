/**
 * `ReportTargetNotFound` carries NO `FateWireCode` by design: it never reaches the
 * wire. The `report.submit` mutation translates it at its own boundary, exactly as the
 * vote mutations translate `VoteTargetNotFound`.
 */
import * as Schema from "effect/Schema";
import {TargetKindSchema} from "../../db/target-kind.ts";
import {TargetId} from "../../lib/ids.ts";

export class ReportTargetNotFound extends Schema.TaggedErrorClass<ReportTargetNotFound>()(
	"report/ReportTargetNotFound",
	{
		targetKind: TargetKindSchema,
		targetId: TargetId,
		message: Schema.String,
	},
) {}
