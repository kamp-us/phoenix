/**
 * The divan root list resolvers. The service reads are unconditional, so the
 * disjunctive {@link requireDivanAccess} gate (yazar OR mod) is enforced HERE:
 * `yield* ViewDivan` makes each read unreachable without the discharged grant.
 *
 * Both are single-page private reads, so the `ConnectionResult` is `hasNext: false`.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {targetKey} from "../../db/target-kind.ts";
import {UserId} from "../../lib/ids.ts";
import {Denied} from "../kunye/errors.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
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

// The handler stamps `__typename` itself: an inline-resolved entity has no source
// that would stamp it.
const toCaylak = (e: DivanRosterRow, viewerVouched: boolean): DivanCaylak => ({
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
	viewerVouched,
});

/**
 * The reading actor's whole vouch set in ONE ledger read, so `viewerVouched` costs the
 * roster a single extra statement rather than a per-row probe (ADR 0021). An anonymous or
 * moderator-only reader simply has none: the yazar floor lives in `user.vouch`, and this
 * read only reports what already exists.
 */
const vouchedByViewer = Effect.fn("divan.vouchedByViewer")(function* () {
	const {user} = yield* CurrentUser;
	if (!user) return new Set<string>();
	const ledger = yield* VouchLedger;
	return new Set(yield* ledger.candidatesVouchedBy(user.id));
});

const toItem = (i: DivanItem): DivanBacklogItem => ({
	__typename: "DivanBacklogItem",
	id: targetKey(i.kind, i.id),
	kind: i.kind,
	authorId: i.authorId,
	createdAt: i.createdAt.toISOString(),
	preview: i.preview,
});

const rosterGated = Effect.fn("divan.rosterGated")(function* () {
	yield* ViewDivan;
	const divan = yield* Divan;
	const roster = yield* divan.roster();
	const vouched = yield* vouchedByViewer();
	return {
		items: roster.map((e) => {
			const node = toCaylak(e, vouched.has(e.authorId));
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
