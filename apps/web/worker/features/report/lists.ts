/**
 * Report root list resolver — `report.listOpen`, the moderation queue (ADR 0098
 * §5). Gated behind the `Moderate` capability (`requireModeration`): a
 * non-moderator (or anonymous) caller gets the invisible `Denied` (`UNAUTHORIZED`)
 * and the queue is invisible to them. The queue is a bounded, private read (no live
 * view, no cursor pagination — the service caps it), so the `ConnectionResult` is
 * single-page (`hasNext: false`).
 *
 * Each row is enriched (#1702) with the reported target's in-situ context —
 * excerpt/title, author, and a routing ref — resolved by dispatching to the owning
 * content service per `targetKind` (the `moderateRemove` dispatch shape in
 * `mutations.ts`). The enrichment stays INSIDE this `Moderate`-gated path, so no
 * new public read exposes reported-target aggregation.
 */
import {Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Denied} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {Moderate, requireModeration} from "../kunye/moderate.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
import {Pano} from "../pano/Pano.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {contextKeyOf, enrichOpenReports, type ReportTargetContext, toExcerpt} from "./enrich.ts";
import type {OpenReportGroup} from "./Report.ts";
import {Report} from "./Report.ts";
import {type RowReputation, reputationKeyOf, rowReputationOf} from "./reputation.ts";
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
// unreachable without a discharged grant. The target-context enrichment dispatches
// to Pano/Sozluk under the same gate.
const listOpenGated = Effect.fn("report.listOpenGated")(function* (args: typeof ListOpenArgs.Type) {
	yield* Moderate;
	const report = yield* Report;
	const groups = yield* report.listOpen(args.first !== undefined ? {limit: args.first} : undefined);
	const contexts = yield* resolveTargetContexts(groups);
	const reputations = yield* resolveRowReputations(groups, contexts);
	return {
		items: enrichOpenReports(groups, contexts, reputations).map((node) => ({
			cursor: node.id,
			node,
		})),
		pagination: {hasNext: false, hasPrevious: false},
	} satisfies ConnectionResult<OpenReport>;
});

// Resolve each group's reported-target context by dispatching a batched read to the
// content service that owns the kind, keyed by `<kind>:<id>`. A target the batched
// read doesn't return (missing / sandbox-hidden) simply has no entry — the merge
// then renders that row with null context (never dropped).
const resolveTargetContexts = Effect.fn("report.resolveTargetContexts")(function* (
	groups: ReadonlyArray<OpenReportGroup>,
) {
	const idsByKind = {
		post: [] as string[],
		comment: [] as string[],
		definition: [] as string[],
	};
	for (const g of groups) idsByKind[g.targetKind].push(g.targetId);

	const contexts = new Map<string, ReportTargetContext>();
	const pano = yield* Pano;
	const sozluk = yield* Sozluk;

	if (idsByKind.post.length > 0) {
		const rows = yield* pano.getPostsByIds(idsByKind.post);
		for (const r of rows) {
			// A post links to its own detail page (`/pano/<id>`); its title is the excerpt.
			contexts.set(contextKeyOf("post", r.id), {
				excerpt: r.title,
				author: r.author,
				ref: r.id,
				authorId: r.authorId,
			});
		}
	}

	if (idsByKind.comment.length > 0) {
		const rows = yield* pano.getCommentsByIds(idsByKind.comment);
		for (const r of rows) {
			// A comment links to its PARENT post detail; resolve the post id per row.
			const postId = yield* pano.lookupCommentPostId(r.id);
			if (postId === null) continue;
			contexts.set(contextKeyOf("comment", r.id), {
				excerpt: toExcerpt(r.body),
				author: r.author,
				ref: postId,
				authorId: r.authorId,
			});
		}
	}

	if (idsByKind.definition.length > 0) {
		const rows = yield* sozluk.getDefinitionsByIds(idsByKind.definition);
		for (const r of rows) {
			// A definition links to its term page (`/sozluk/<slug>`); resolve the slug per row.
			const slug = yield* sozluk.lookupDefinitionTermSlug(r.id);
			if (slug === null) continue;
			contexts.set(contextKeyOf("definition", r.id), {
				excerpt: toExcerpt(r.body),
				author: r.author,
				ref: slug,
				authorId: r.authorId,
			});
		}
	}

	return contexts;
});

// Join each group's reputation + actor cluster (#1703/#1852, ADR 0138) INSIDE the gated
// read: the reported target author's künye standing (tier + karma), prior removals, and
// — for the actor-drawer — their live production footprint, kefil (vouch) status, and
// "bu aktör" open-reported-target count, plus the pile-on's distinct-reporter count.
// Author fields are keyed by the `authorId` the context resolution captured; a group
// whose author is unresolved folds to a null author cluster. Every per-page aggregate
// is one batched read (removals / production / reported-targets / diversity), so the
// join stays a MODE over the same gated surface, never a per-row waterfall.
const resolveRowReputations = Effect.fn("report.resolveRowReputations")(function* (
	groups: ReadonlyArray<OpenReportGroup>,
	contexts: ReadonlyMap<string, ReportTargetContext>,
) {
	const kunye = yield* Kunye;
	const report = yield* Report;
	const vouches = yield* VouchLedger;

	const authorIds = [
		...new Set(
			groups
				.map((g) => contexts.get(contextKeyOf(g.targetKind, g.targetId))?.authorId)
				.filter((id): id is string => id !== undefined),
		),
	];

	// The per-page batched aggregates — one read each, all bounded by the page size.
	const priorRemovals = yield* report.countRemovalsByAuthors(authorIds);
	const production = yield* report.productionCountsByAuthors(authorIds);
	const reportedTargets = yield* report.countOpenReportedTargetsByAuthors(authorIds);
	const diversity = yield* report.reporterDiversity(
		groups.map((g) => ({targetKind: g.targetKind, targetId: g.targetId})),
	);
	// Kefil status is a per-author lookup (no batched read on the ledger yet); resolved
	// once per distinct author, not per row, so the page stays a bounded fan-out.
	const kefilByAuthor = new Map<string, boolean>();
	for (const id of authorIds) kefilByAuthor.set(id, yield* vouches.hasActiveFor(id));

	const reputations = new Map<string, RowReputation>();
	for (const g of groups) {
		const key = reputationKeyOf(g.targetKind, g.targetId);
		const authorId = contexts.get(contextKeyOf(g.targetKind, g.targetId))?.authorId;
		const counts = authorId === undefined ? undefined : production.get(authorId);
		const reputation =
			authorId === undefined
				? undefined
				: {
						authorId,
						tier: yield* kunye.tierOf(authorId),
						karma: yield* kunye.karmaOf(authorId),
						priorRemovals: priorRemovals.get(authorId) ?? 0,
						definitionCount: counts?.definitionCount ?? 0,
						postCount: counts?.postCount ?? 0,
						commentCount: counts?.commentCount ?? 0,
						kefil: kefilByAuthor.get(authorId) ?? false,
						reportedTargets: reportedTargets.get(authorId) ?? 0,
					};
		reputations.set(key, rowReputationOf(g, reputation, diversity.get(key)));
	}
	return reputations;
});
