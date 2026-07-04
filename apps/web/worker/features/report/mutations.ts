/**
 * Report mutation resolvers (ADR 0098):
 *
 * - `report.submit` — the capture-side write. `CurrentUser.required` gates it; the
 *   handler returns a `ReportReceipt` ack and translates the service's kind-blind
 *   `ReportTargetNotFound` into the per-feature not-found the wire knows.
 * - `report.resolve` — the moderation-side write. The `Moderate` capability gates
 *   it (`requireModeration`): anonymous or non-moderator → the invisible `Denied`
 *   (`UNAUTHORIZED`), so the surface is invisible to non-moderators; the discharged
 *   `Grant` threads through the R-channel, so the resolve stamps `resolver_id` /
 *   `removed_by` from the authority-checked identity (`moderatorOf`) and resolving
 *   without a `Grant` does not typecheck (ADR 0107). On `removed` it calls the
 *   content service's moderator-remove, reusing the 0096 substrate with reason
 *   `Moderated({reportId})`, then collapses EVERY open report on the target with
 *   the audit triad. The state machine in `resolution.ts` keeps an illegal
 *   transition unrepresentable.
 *
 * Both acks are returned inline (the interpreter stamps `__typename` only on
 * source-resolved entities), so the handlers shape them through the shapers.
 * See `.patterns/fate-effect-operations.md`.
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import type {TargetKind} from "../../db/target-kind.ts";
import {TargetKindSchema} from "../../db/target-kind.ts";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {Denied} from "../kunye/errors.ts";
import {Moderate, moderatorOf, requireModeration} from "../kunye/moderate.ts";
import {CommentNotFound, PostNotFound} from "../pano/errors.ts";
import {Pano} from "../pano/Pano.ts";
import {toComment, toPost} from "../pano/shapers.ts";
import {DefinitionNotFound} from "../sozluk/errors.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {toDefinition} from "../sozluk/shapers.ts";
import type {ReportTargetNotFound} from "./errors.ts";
import {reportLive} from "./live.ts";
import {Report} from "./Report.ts";
import {outcomeOf} from "./resolution.ts";
import {toReportReceipt, toResolveReceipt} from "./shapers.ts";
import {ReportReceiptView, ResolveReceiptView} from "./views.ts";

const SubmitReportInput = Schema.Struct({
	targetKind: TargetKindSchema,
	targetId: Schema.String,
	reason: Schema.optional(Schema.NullOr(Schema.String)),
});

// Either name the target directly (the moderation queue surfaces `targetKind` +
// `targetId`), or pass a `reportId` and the resolve acts on its whole target group.
const ResolveReportInput = Schema.Struct({
	reportId: Schema.optional(Schema.String),
	targetKind: Schema.optional(TargetKindSchema),
	targetId: Schema.optional(Schema.String),
	action: Schema.Literals(["remove", "dismiss"]),
});

const RestoreReportInput = Schema.Struct({
	reportId: Schema.optional(Schema.String),
	targetKind: Schema.optional(TargetKindSchema),
	targetId: Schema.optional(Schema.String),
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

	"report.resolve": Fate.mutation(
		{
			input: ResolveReportInput,
			type: ResolveReceiptView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("report.resolve")(function* ({input}) {
			return yield* requireModeration(resolveGated(input));
		}),
	),

	// The reopen edge (ADR 0098 §3 / 0096 §4): a moderator restore of a removed
	// target brings the content back live AND reopens its reports (the bounded
	// reopen). `Moderate`-gated, like resolve.
	"report.restore": Fate.mutation(
		{
			input: RestoreReportInput,
			type: ResolveReceiptView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("report.restore")(function* ({input}) {
			return yield* requireModeration(restoreGated(input));
		}),
	),
};

// The post-gate resolve body — runnable only with a `Moderate` `Grant` in R
// (`requireModeration` provides it). It reads the grant for the authority-checked
// moderator id (`moderatorOf`) it stamps as `resolver_id`/`removed_by`, so
// resolving without a discharged grant is a compile error.
const resolveGated = Effect.fn("report.resolveGated")(function* (
	input: typeof ResolveReportInput.Type,
) {
	const grant = yield* Moderate;
	const moderatorId = yield* moderatorOf(grant);
	const report = yield* Report;
	const live = reportLive(yield* WorkerLivePublisher);

	// Resolve the target: a `reportId` resolves to its `(targetKind, targetId)`;
	// otherwise `targetKind` + `targetId` are taken directly.
	let target: {targetKind: TargetKind; targetId: string} | null = null;
	if (input.reportId !== undefined) {
		target = yield* report.lookupReportTarget(input.reportId);
	} else if (input.targetKind !== undefined && input.targetId !== undefined) {
		target = {targetKind: input.targetKind, targetId: input.targetId};
	}
	// A stale/unknown target is a benign no-op (nothing to collapse) — the
	// moderation surface never leaks "exists/doesn't" beyond UNAUTHORIZED.
	if (target === null) {
		return toResolveReceipt({
			targetKind: input.targetKind ?? "post",
			targetId: input.targetId ?? "",
			resolution: outcomeOf(input.action),
			targetRemoved: false,
			collapsed: 0,
		});
	}

	const now = new Date();
	let targetRemoved = false;

	if (input.action === "remove") {
		// Act on the target via the 0096 substrate (reason `Moderated`); the
		// reportId carried into the removal is the FIRST open report id on the
		// target, so a later restore can reopen the group.
		const firstId = yield* report.firstOpenReportId(target.targetKind, target.targetId);
		const reportId = firstId ?? input.reportId ?? `${target.targetKind}:${target.targetId}`;
		targetRemoved = yield* moderateRemove(target, moderatorId, reportId);
		// The moderator-remove hides content that lives in the subscribed
		// `posts` / `Post.comments` / `Term.definitions` connections; publish the
		// same invalidation the user-delete paths do so every other client's open
		// view reconciles live (#1895, audit #1892). Only fan out on an actual
		// removal — a no-op (already-removed / missing) changed no subscribed state.
		if (targetRemoved) {
			yield* publishRemoved(live, target);
		}
	}

	const {collapsed} = yield* report.resolveTarget({
		targetKind: target.targetKind,
		targetId: target.targetId,
		resolverId: moderatorId,
		action: input.action,
		resolvedAt: now,
	});

	return toResolveReceipt({
		targetKind: target.targetKind,
		targetId: target.targetId,
		resolution: outcomeOf(input.action),
		targetRemoved,
		collapsed,
	});
});

// The post-gate restore body — `Moderate`-gated in R like {@link resolveGated}.
// `reopenForTarget` clears the audit triad (no moderator id stamped on reopen), so
// the grant is read only to require the proof; `yield* Moderate` IS that gate.
const restoreGated = Effect.fn("report.restoreGated")(function* (
	input: typeof RestoreReportInput.Type,
) {
	yield* Moderate;
	const report = yield* Report;
	const live = reportLive(yield* WorkerLivePublisher);

	let target: {targetKind: TargetKind; targetId: string} | null = null;
	if (input.reportId !== undefined) {
		target = yield* report.lookupReportTarget(input.reportId);
	} else if (input.targetKind !== undefined && input.targetId !== undefined) {
		target = {targetKind: input.targetKind, targetId: input.targetId};
	}
	if (target === null) {
		return toResolveReceipt({
			targetKind: input.targetKind ?? "post",
			targetId: input.targetId ?? "",
			resolution: "dismissed",
			targetRemoved: false,
			collapsed: 0,
		});
	}

	const restored = yield* moderateRestore(target);
	// Mirror the remove fan-out: re-enter the target into the subscribed connection so
	// every other client's open view re-populates live (#1895). Only on an actual
	// restore — a no-op restored nothing.
	if (restored.restored) {
		yield* publishRestored(live, target, restored.sandboxedAt);
	}
	const {reopened} = yield* report.reopenForTarget(target);

	return toResolveReceipt({
		targetKind: target.targetKind,
		targetId: target.targetId,
		resolution: "dismissed",
		targetRemoved: !restored.restored,
		collapsed: reopened,
	});
});

/** Dispatch act-on-target to the content service that owns the target kind. */
const moderateRemove = Effect.fn("report.moderateRemove")(function* (
	target: {targetKind: TargetKind; targetId: string},
	resolverId: string,
	reportId: string,
) {
	switch (target.targetKind) {
		case "definition": {
			const sozluk = yield* Sozluk;
			const {removed} = yield* sozluk.moderateRemoveDefinition({
				definitionId: target.targetId,
				resolverId,
				reportId,
			});
			return removed;
		}
		case "post": {
			const pano = yield* Pano;
			const {removed} = yield* pano.moderateRemovePost({
				postId: target.targetId,
				resolverId,
				reportId,
			});
			return removed;
		}
		case "comment": {
			const pano = yield* Pano;
			const {removed} = yield* pano.moderateRemoveComment({
				commentId: target.targetId,
				resolverId,
				reportId,
			});
			return removed;
		}
	}
});

/**
 * Dispatch the moderator restore to the content service that owns the target kind.
 * `sandboxedAt` is the round-tripped sandbox marker (#1811) the caller feeds to the
 * live re-append's `decidePublish` gate — a sandboxed restore stays out of the public
 * connection.
 */
const moderateRestore = Effect.fn("report.moderateRestore")(function* (target: {
	targetKind: TargetKind;
	targetId: string;
}) {
	switch (target.targetKind) {
		case "definition": {
			const sozluk = yield* Sozluk;
			return yield* sozluk.moderateRestoreDefinition({definitionId: target.targetId});
		}
		case "post": {
			const pano = yield* Pano;
			return yield* pano.moderateRestorePost({postId: target.targetId});
		}
		case "comment": {
			const pano = yield* Pano;
			return yield* pano.moderateRestoreComment({commentId: target.targetId});
		}
	}
});

/**
 * Publish the remove-side invalidation for a moderator-removed target: evict the entity
 * + drop its edge from the connection it lives in (`posts` / `Post.comments` /
 * `Term.definitions`), resolving the parent ref (post id for a comment, term slug for a
 * definition) the same way the content features' delete paths do. A ref the lookup can't
 * resolve (already gone) simply skips its connection edge — the entity eviction still
 * fires. Publisher errors are `never`, so this can never fail the moderation action.
 */
const publishRemoved = Effect.fn("report.publishRemoved")(function* (
	live: ReturnType<typeof reportLive>,
	target: {targetKind: TargetKind; targetId: string},
) {
	switch (target.targetKind) {
		case "post": {
			yield* live.postRemoved(target.targetId);
			return;
		}
		case "comment": {
			const pano = yield* Pano;
			const postId = yield* pano.lookupCommentPostId(target.targetId);
			if (postId !== null) yield* live.commentRemoved(target.targetId, postId);
			return;
		}
		case "definition": {
			const sozluk = yield* Sozluk;
			const slug = yield* sozluk.lookupDefinitionTermSlug(target.targetId);
			if (slug !== null) yield* live.definitionRemoved(target.targetId, slug);
			return;
		}
	}
});

/**
 * Publish the restore-side invalidation for a moderator-restored target: re-resolve the
 * full node (via the content service's batched by-id read) and re-append it to the
 * connection, gated on the round-tripped `sandboxedAt` so a still-sandboxed restore
 * stays suppressed from the viewer-blind public topic (#1205/#1280 leak surface),
 * mirroring the user restore paths. A node that no longer resolves is skipped. Publisher
 * errors are `never`.
 */
const publishRestored = Effect.fn("report.publishRestored")(function* (
	live: ReturnType<typeof reportLive>,
	target: {targetKind: TargetKind; targetId: string},
	sandboxedAt: Date | null,
) {
	switch (target.targetKind) {
		case "post": {
			const pano = yield* Pano;
			const [row] = yield* pano.getPostsByIds([target.targetId]);
			if (row) yield* live.postRestored(toPost(row), sandboxedAt);
			return;
		}
		case "comment": {
			const pano = yield* Pano;
			const postId = yield* pano.lookupCommentPostId(target.targetId);
			if (postId === null) return;
			const [row] = yield* pano.getCommentsByIds([target.targetId]);
			if (row) yield* live.commentRestored(toComment(row), postId, sandboxedAt);
			return;
		}
		case "definition": {
			const sozluk = yield* Sozluk;
			const slug = yield* sozluk.lookupDefinitionTermSlug(target.targetId);
			if (slug === null) return;
			const [row] = yield* sozluk.getDefinitionsByIds([target.targetId]);
			if (row) yield* live.definitionRestored(toDefinition(row), slug, sandboxedAt);
			return;
		}
	}
});
