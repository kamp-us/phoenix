/**
 * The divan root list resolvers (#1287, epic #1202) — the gated proving-ground read
 * model every other divan slice (voting #1288, vouch/tandem #1289, the `/divan`
 * surface #1290, the çaylak status block #1291) reads off.
 *
 * The disjunctive {@link requireDivanAccess} capability gate — yazar OR mod — is
 * enforced HERE (the service reads are unconditional): `yield* ViewDivan` makes each
 * read unreachable without the discharged grant.
 *
 * Both are single-page private reads (no live view, no cursor pagination), so the
 * `ConnectionResult` is `hasNext: false`, mirroring `report.listOpen`.
 */
import {Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {targetKey} from "../../db/target-kind.ts";
import {UserId} from "../../lib/ids.ts";
import {Denied} from "../kunye/errors.ts";
import {Divan} from "./Divan.ts";
import {requireDivanAccess, ViewDivan} from "./gate.ts";
import type {DivanItem, DivanRosterRow} from "./roster.ts";
import {
	type DivanBacklogItem,
	DivanBacklogItemView,
	type DivanCaylak,
	DivanCaylakView,
} from "./views.ts";

const RosterArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
});

const BacklogArgs = Schema.Struct({
	authorId: UserId,
	first: Schema.optional(Schema.Number),
});

// The handler stamps `__typename` (the inline-resolved entity carries no source that
// would stamp it) — the one spelling of each literal. See `report/shapers.ts`.
const toCaylak = (e: DivanRosterRow): DivanCaylak => ({
	__typename: "DivanCaylak",
	id: e.authorId,
	authorId: e.authorId,
	username: e.username,
	displayName: e.displayName,
	totalKarma: e.totalKarma,
	definitionCount: e.definitionCount,
	postCount: e.postCount,
	commentCount: e.commentCount,
	totalCount: e.totalCount,
});

const toItem = (i: DivanItem): DivanBacklogItem => ({
	__typename: "DivanBacklogItem",
	id: targetKey(i.kind, i.id),
	kind: i.kind,
	authorId: i.authorId,
	createdAt: i.createdAt.toISOString(),
	preview: i.preview,
});

// The post-gate roster read — `ViewDivan`-gated in R (`requireDivanAccess` provides
// the grant). `yield* ViewDivan` requires the proof; the roster is unreachable
// without a discharged grant.
const rosterGated = Effect.fn("divan.rosterGated")(function* () {
	yield* ViewDivan;
	const divan = yield* Divan;
	const roster = yield* divan.roster();
	return {
		items: roster.map((e) => {
			const node = toCaylak(e);
			return {cursor: node.id, node};
		}),
		pagination: {hasNext: false, hasPrevious: false},
	} satisfies ConnectionResult<DivanCaylak>;
});

const backlogGated = Effect.fn("divan.backlogGated")(function* (authorId: UserId) {
	yield* ViewDivan;
	const divan = yield* Divan;
	const items = yield* divan.backlogOf(authorId);
	return {
		items: items.map((i) => {
			const node = toItem(i);
			return {cursor: node.id, node};
		}),
		pagination: {hasNext: false, hasPrevious: false},
	} satisfies ConnectionResult<DivanBacklogItem>;
});

export const lists = {
	"divan.roster": Fate.list(
		{
			args: RosterArgs,
			type: DivanCaylakView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("divan.roster")(function* () {
			return yield* requireDivanAccess(rosterGated());
		}),
	),
	"divan.backlog": Fate.list(
		{
			args: BacklogArgs,
			type: DivanBacklogItemView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("divan.backlog")(function* ({args}) {
			return yield* requireDivanAccess(backlogGated(args.authorId));
		}),
	),
};
