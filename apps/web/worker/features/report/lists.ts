/**
 * Report root list resolver — `report.listOpen`, the moderation queue (ADR 0098
 * §5). Gated behind `Moderator.required`: a non-moderator (or anonymous) caller
 * gets `UNAUTHORIZED` and the queue is invisible to them. The queue is a bounded,
 * private read (no live view, no cursor pagination — the service caps it), so the
 * `ConnectionResult` is single-page (`hasNext: false`).
 */
import {Fate, Unauthorized} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Moderator, NotAModerator} from "./Moderator.ts";
import {Report} from "./Report.ts";
import {toOpenReport} from "./shapers.ts";
import type {OpenReport} from "./views.ts";
import {OpenReportView} from "./views.ts";

const ListOpenArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
});

export const lists = {
	"report.listOpen": Fate.list(
		{
			args: ListOpenArgs,
			type: OpenReportView,
			error: Schema.Union([Unauthorized, NotAModerator]),
		},
		Effect.fn("report.listOpen")(function* ({args}) {
			yield* Moderator.required;
			const report = yield* Report;
			const groups = yield* report.listOpen(
				args.first !== undefined ? {limit: args.first} : undefined,
			);
			return {
				items: groups.map((g) => {
					const node = toOpenReport(g);
					return {cursor: node.id, node};
				}),
				pagination: {hasNext: false, hasPrevious: false},
			} satisfies ConnectionResult<OpenReport>;
		}),
	),
};
