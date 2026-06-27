/**
 * Report root list resolver — `report.listOpen`, the moderation queue (ADR 0098
 * §5). Gated behind the `Moderate` capability (`requireModeration`): a
 * non-moderator (or anonymous) caller gets the invisible `Denied` (`UNAUTHORIZED`)
 * and the queue is invisible to them. The queue is a bounded, private read (no live
 * view, no cursor pagination — the service caps it), so the `ConnectionResult` is
 * single-page (`hasNext: false`).
 */
import {Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Denied} from "../kunye/errors.ts";
import {Moderate, requireModeration} from "../kunye/moderate.ts";
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
			error: Schema.Union([Denied]),
		},
		Effect.fn("report.listOpen")(function* ({args}) {
			return yield* requireModeration(listOpenGated(args));
		}),
	),
};

// The post-gate queue read — `Moderate`-gated in R (`requireModeration` provides
// the grant). `yield* Moderate` requires the proof; the read is a private surface
// unreachable without a discharged grant.
const listOpenGated = Effect.fn("report.listOpenGated")(function* (args: typeof ListOpenArgs.Type) {
	yield* Moderate;
	const report = yield* Report;
	const groups = yield* report.listOpen(args.first !== undefined ? {limit: args.first} : undefined);
	return {
		items: groups.map((g) => {
			const node = toOpenReport(g);
			return {cursor: node.id, node};
		}),
		pagination: {hasNext: false, hasPrevious: false},
	} satisfies ConnectionResult<OpenReport>;
});
