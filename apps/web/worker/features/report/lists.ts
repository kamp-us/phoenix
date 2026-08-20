/**
 * The moderation queue's root list resolvers (ADR 0098 §5). The queue is a bounded,
 * private read — the service caps it, so the `ConnectionResult` is single-page.
 *
 * All target-context enrichment stays INSIDE the `Moderate`-gated path, so no new
 * public read exposes reported-target aggregation.
 */
import {Fate} from "@kampus/fate-effect";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import type {TargetKind} from "../../db/target-kind.ts";
import {Denied} from "../kunye/errors.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {Moderate, requireModeration} from "../kunye/moderate.ts";
import {moderatorSandboxViewer} from "../kunye/sandbox.ts";
import {VouchLedger} from "../kunye/VouchLedger.ts";
import {Pano} from "../pano/Pano.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {
	contextKeyOf,
	enrichOpenReports,
	enrichResolvedReports,
	type ReportTargetContext,
	toExcerpt,
} from "./enrich.ts";
import type {OpenReportGroup, ResolvedReportGroup} from "./Report.ts";
import {Report} from "./Report.ts";
import {type RowReputation, reputationKeyOf, rowReputationOf} from "./reputation.ts";
import type {OpenReport, ResolvedReport} from "./views.ts";
import {OpenReportView, ResolvedReportView} from "./views.ts";

const ListOpenArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
});

const ListResolvedArgs = Schema.Struct({
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

	"report.listResolved": Fate.list(
		{
			args: ListResolvedArgs,
			type: ResolvedReportView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("report.listResolved")(function* ({args}) {
			return yield* requireModeration(listResolvedGated(args));
		}),
	),
};

// `yield* Moderate` puts the grant in R, so this read is unreachable without a
// discharged proof — that is the gate, not a branch in the body.
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

const listResolvedGated = Effect.fn("report.listResolvedGated")(function* (
	args: typeof ListResolvedArgs.Type,
) {
	yield* Moderate;
	const report = yield* Report;
	const groups = yield* report.listResolved(
		args.first !== undefined ? {limit: args.first} : undefined,
	);
	const contexts = yield* resolveTargetContexts(groups);
	const resolverHandles = yield* resolveResolverHandles(groups);
	return {
		items: enrichResolvedReports(groups, contexts, resolverHandles).map((node) => ({
			cursor: node.id,
			node,
		})),
		pagination: {hasNext: false, hasPrevious: false},
	} satisfies ConnectionResult<ResolvedReport>;
});

// An unresolved id simply has no entry — the merge then renders that row with a null
// handle, never drops it.
const resolveResolverHandles = Effect.fn("report.resolveResolverHandles")(function* (
	groups: ReadonlyArray<ResolvedReportGroup>,
) {
	const handles = new Map<string, string | null>();
	const resolverIds = [...new Set(groups.map((g) => g.resolverId))];
	if (resolverIds.length === 0) return handles;
	const pasaport = yield* Pasaport;
	const identities = yield* pasaport.getProfileIdentitiesByIds(resolverIds);
	for (const row of identities) {
		handles.set(row.userId, row.displayName ?? row.username ?? null);
	}
	return handles;
});

// A target the batched read doesn't return (missing / removed) simply has no entry — the
// merge renders that row with null context, never drops it. A still-SANDBOXED target is
// no longer in that set: these reads run under the moderator's own sandbox viewer, so the
// çaylak reports the sandbox exists to make reviewable are the ones that hydrate (#6472).
const resolveTargetContexts = Effect.fn("report.resolveTargetContexts")(function* (
	groups: ReadonlyArray<{targetKind: TargetKind; targetId: string}>,
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
	const sandboxViewer = yield* moderatorSandboxViewer;

	if (idsByKind.post.length > 0) {
		const rows = yield* pano.getPostsByIds(idsByKind.post, {sandboxViewer});
		for (const r of rows) {
			contexts.set(contextKeyOf("post", r.id), {
				excerpt: r.title,
				author: r.author,
				ref: r.id,
				authorId: r.authorId,
			});
		}
	}

	if (idsByKind.comment.length > 0) {
		const rows = yield* pano.getCommentsByIds(idsByKind.comment, {sandboxViewer});
		for (const r of rows) {
			// A comment routes to its PARENT post's detail page.
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
		const rows = yield* sozluk.getDefinitionsByIds(idsByKind.definition, {sandboxViewer});
		for (const r of rows) {
			// A definition routes to its term page, keyed by slug.
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

// A group whose author is unresolved folds to a null author cluster. Every per-page
// aggregate must stay ONE batched read, never a per-row waterfall (ADR 0138).
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

	const priorRemovals = yield* report.countRemovalsByAuthors(authorIds);
	const production = yield* report.productionCountsByAuthors(authorIds);
	const reportedTargets = yield* report.countOpenReportedTargetsByAuthors(authorIds);
	const diversity = yield* report.reporterDiversity(
		groups.map((g) => ({targetKind: g.targetKind, targetId: g.targetId})),
	);
	// No batched read on the ledger yet, so this is per-author — resolved once per
	// DISTINCT author, not per row, to keep the fan-out bounded.
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
