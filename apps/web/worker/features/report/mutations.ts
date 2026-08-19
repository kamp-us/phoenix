/**
 * Report mutation resolvers (ADR 0098). The moderation-side writes thread a discharged
 * `Moderate` grant through R, so resolving without one does not typecheck (ADR 0107).
 * See `.patterns/fate-effect-operations.md`.
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {type TargetKind, TargetKindSchema, targetKey} from "../../db/target-kind.ts";
import {TargetId} from "../../lib/ids.ts";
import {notifyReportFiled} from "../bildirim/mod-emitters.ts";
import {WorkerLivePublisher} from "../fate-live/protocol.ts";
import {Denied, InsufficientKarma} from "../kunye/errors.ts";
import {Moderate, moderatorOf, requireModeration} from "../kunye/moderate.ts";
import {gateFlagOnKarma} from "../kunye/privilege.ts";
import {CommentNotFound, PostNotFound} from "../pano/errors.ts";
import {PanoFeedCache} from "../pano/feed-cache.ts";
import {Pano} from "../pano/Pano.ts";
import {toComment, toPost} from "../pano/shapers.ts";
import {DefinitionNotFound} from "../sozluk/errors.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {toDefinition} from "../sozluk/shapers.ts";
import type {ReportTargetNotFound} from "./errors.ts";
import {ReportId, WaveId} from "./ids.ts";
import {reportLive} from "./live.ts";
import {Report} from "./Report.ts";
import {outcomeOf} from "./resolution.ts";
import {toReportReceipt, toResolveReceipt} from "./shapers.ts";
import {ReportReceiptView, ResolveReceiptView} from "./views.ts";

const SubmitReportInput = Schema.Struct({
	targetKind: TargetKindSchema,
	targetId: TargetId,
	reason: Schema.optional(Schema.NullOr(Schema.String)),
});

// `waveId` is the remove-the-wave grouping id (#1855): the client generates ONE per wave
// gesture and threads the SAME id through every fanned-out resolve, so the batch reopens
// as a unit. Absent on a single-target resolve.
const ResolveReportInput = Schema.Struct({
	reportId: Schema.optional(ReportId),
	targetKind: Schema.optional(TargetKindSchema),
	targetId: Schema.optional(TargetId),
	action: Schema.Literals(["remove", "dismiss"]),
	waveId: Schema.optional(Schema.NullOr(WaveId)),
});

const RestoreReportInput = Schema.Struct({
	reportId: Schema.optional(ReportId),
	targetKind: Schema.optional(TargetKindSchema),
	targetId: Schema.optional(TargetId),
});

const RestoreWaveReportInput = Schema.Struct({
	waveId: WaveId,
});

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
			error: Schema.Union([
				Unauthorized,
				InsufficientKarma,
				PostNotFound,
				CommentNotFound,
				DefinitionNotFound,
			]),
			type: ReportReceiptView,
		},
		Effect.fn("report.submit")(function* ({input}) {
			const user = yield* CurrentUser.required;
			const submit = Effect.fn("report.submitBody")(function* () {
				const report = yield* Report;
				const result = yield* report
					.submit({
						reporterId: user.id,
						targetKind: input.targetKind,
						targetId: input.targetId,
						reason: input.reason ?? null,
					})
					.pipe(
						Effect.catchTag("report/ReportTargetNotFound", (e) =>
							Effect.fail(toFeatureNotFound(e)),
						),
					);
				// Only a GENUINELY new report pages the moderators — never an idempotent
				// re-report. Swallowed inside the emitter, so it can't fail the committed report.
				if (result.created) {
					yield* notifyReportFiled({
						reporterId: user.id,
						targetKind: input.targetKind,
						targetId: input.targetId,
					});
				}
				return toReportReceipt(result);
			});
			// Karma floor on FILING (#150), dark by default — a separate axis from the ADR
			// 0098 moderation surface, which gates report *resolution*.
			return yield* gateFlagOnKarma(submit());
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

	// The reopen edge (ADR 0098 §3 / 0096 §4): a restore brings the content back live AND
	// reopens its reports.
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

	// Restore a wave-removal as a unit (#1855, ADR 0138).
	"report.restoreWave": Fate.mutation(
		{
			input: RestoreWaveReportInput,
			type: ResolveReceiptView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("report.restoreWave")(function* ({input}) {
			return yield* requireModeration(restoreWaveGated(input));
		}),
	),
};

// `moderatorOf(grant)` is the authority-checked id stamped as `resolver_id`/`removed_by` —
// never a client-supplied one.
const resolveGated = Effect.fn("report.resolveGated")(function* (
	input: typeof ResolveReportInput.Type,
) {
	const grant = yield* Moderate;
	const moderatorId = yield* moderatorOf(grant);
	const report = yield* Report;
	const live = reportLive(yield* WorkerLivePublisher, yield* PanoFeedCache);

	let target: {targetKind: TargetKind; targetId: string} | null = null;
	if (input.reportId !== undefined) {
		target = yield* report.lookupReportTarget(input.reportId);
	} else if (input.targetKind !== undefined && input.targetId !== undefined) {
		target = {targetKind: input.targetKind, targetId: input.targetId};
	}
	// A stale/unknown target acks benignly on purpose: the moderation surface must never
	// leak "exists/doesn't".
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

	// Must be read BEFORE the stamp below flips open → terminal: afterwards there are no
	// open rows left to read, and the removal needs this id to link its `Moderated` reason.
	const firstOpenId =
		input.action === "remove"
			? yield* report.firstOpenReportId(target.targetKind, target.targetId)
			: null;

	// Stamp first, remove only if this resolve WON the transition (#2555). A concurrent
	// moderator who stamped terminal first leaves `wonTransition` false, so the removal is
	// skipped and content is never removed under their (e.g. dismissed) verdict.
	const {collapsed, wonTransition} = yield* report.resolveTarget({
		targetKind: target.targetKind,
		targetId: target.targetId,
		resolverId: moderatorId,
		action: input.action,
		resolvedAt: now,
		waveId: input.waveId ?? null,
	});

	if (input.action === "remove" && wonTransition) {
		const reportId = ReportId.make(
			firstOpenId ?? input.reportId ?? targetKey(target.targetKind, target.targetId),
		);
		targetRemoved = yield* moderateRemove(target, moderatorId, reportId);
		// The removed content lives in a subscribed connection, so it needs the same
		// invalidation the user-delete paths publish (#1895). Only on an ACTUAL removal —
		// a no-op changed no subscribed state.
		if (targetRemoved) {
			yield* publishRemoved(live, target);
		}
	}

	return toResolveReceipt({
		targetKind: target.targetKind,
		targetId: target.targetId,
		resolution: outcomeOf(input.action),
		targetRemoved,
		collapsed,
	});
});

// `reopenForTarget` stamps no moderator id, so the grant is yielded purely as the gate.
const restoreGated = Effect.fn("report.restoreGated")(function* (
	input: typeof RestoreReportInput.Type,
) {
	yield* Moderate;
	const report = yield* Report;
	const live = reportLive(yield* WorkerLivePublisher, yield* PanoFeedCache);

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
	// Mirrors the remove fan-out (#1895); only on an actual restore.
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

// The batch is exactly the wave — one shared id — so nothing outside it is touched.
const restoreWaveGated = Effect.fn("report.restoreWaveGated")(function* (
	input: typeof RestoreWaveReportInput.Type,
) {
	yield* Moderate;
	const report = yield* Report;
	const live = reportLive(yield* WorkerLivePublisher, yield* PanoFeedCache);

	// Content comes back live BEFORE the reports flip open.
	const targets = yield* report.waveTargets(input.waveId);
	for (const target of targets) {
		const restored = yield* moderateRestore(target);
		if (restored.restored) {
			yield* publishRestored(live, target, restored.sandboxedAt);
		}
	}

	const {reopened} = yield* report.reopenForWave(input.waveId);

	// A wave has no single target, so the receipt names the wave itself as the id.
	const first = targets[0];
	return toResolveReceipt({
		targetKind: first?.targetKind ?? "post",
		targetId: input.waveId,
		resolution: "dismissed",
		targetRemoved: false,
		collapsed: reopened,
	});
});

const moderateRemove = Effect.fn("report.moderateRemove")(function* (
	target: {targetKind: TargetKind; targetId: string},
	resolverId: string,
	reportId: ReportId,
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
 * Returns the round-tripped `sandboxedAt` marker (#1811) the caller must feed to the live
 * re-append's `decidePublish` gate — a sandboxed restore stays out of the public connection.
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

/** A parent ref that no longer resolves skips its connection edge on purpose. */
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
 * Gated on `sandboxedAt` so a still-sandboxed restore stays suppressed from the
 * viewer-blind public topic (#1205/#1280 leak surface).
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
