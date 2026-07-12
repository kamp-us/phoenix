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

// Either name the target directly (the moderation queue surfaces `targetKind` +
// `targetId`), or pass a `reportId` and the resolve acts on its whole target group.
// `waveId` is the remove-the-wave grouping id (#1855): the client generates ONE per
// wave gesture and threads the SAME id through every fanned-out resolve, so the batch
// reopens as a unit. Absent on a single-target resolve. The three ids are distinct
// brands (ReportId / TargetId / WaveId), so transposing them here is a compile error.
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

// Restore a whole wave-removal (#1855) as a unit: the `waveId` names the one grouping id
// the wave gesture stamped across its targets, so restore brings EVERY target in the batch
// back live and reopens every report sharing the id together.
const RestoreWaveReportInput = Schema.Struct({
	waveId: WaveId,
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
				// Mod-queue heartbeat (#1699): page every moderator that a report was filed —
				// but only on a GENUINELY new report (`created`), never an idempotent re-report.
				// Flag-gated, moderator-resolved and swallowed inside the emitter, so it can
				// never fail this committed report.
				if (result.created) {
					yield* notifyReportFiled({
						reporterId: user.id,
						targetKind: input.targetKind,
						targetId: input.targetId,
					});
				}
				return toReportReceipt(result);
			});
			// Flag-value karma gate (#150), dark behind the default-off
			// `phoenix-karma-gates` flag: ON ⇒ `CanFlag` floors the reporter's karma at
			// ≥ 50 before the submit runs (a below-floor flagger is denied
			// `INSUFFICIENT_KARMA`); OFF ⇒ inert, every report behaves as today. A
			// SEPARATE axis from the ADR 0098 moderation surface (which gates report
			// *resolution*), not a re-gate of the same fact (#150 rescope).
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

	// Restore a wave-removal as a unit (#1855, ADR 0138): reopen every report sharing the
	// `waveId` AND bring each of the batch's targets back live — the restore-as-a-unit
	// counterpart to a wave `report.resolve`. `Moderate`-gated, like restore.
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
	const live = reportLive(yield* WorkerLivePublisher, yield* PanoFeedCache);

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

	// Capture the representative open report id BEFORE the stamp (below) flips
	// open → terminal: the removal links its `Moderated` reason to it so a later
	// restore reopens the group, and after the stamp there are no open rows left to
	// read. Only the remove leg consumes it.
	const firstOpenId =
		input.action === "remove"
			? yield* report.firstOpenReportId(target.targetKind, target.targetId)
			: null;

	// Stamp first, then remove only if this resolve WON the transition (#2555): the
	// terminal stamp is the single arbiter of open → terminal, so keying the removal on
	// `wonTransition` makes the two legs unable to disagree. A concurrent moderator who
	// stamped the report terminal first leaves `wonTransition` false, so the removal is
	// skipped — content is never removed under their (e.g. dismissed) verdict.
	const {collapsed, wonTransition} = yield* report.resolveTarget({
		targetKind: target.targetKind,
		targetId: target.targetId,
		resolverId: moderatorId,
		action: input.action,
		resolvedAt: now,
		// Stamp the wave grouping when this resolve is one target of a wave gesture
		// (#1855); null on a single-target resolve.
		waveId: input.waveId ?? null,
	});

	if (input.action === "remove" && wonTransition) {
		// Act on the target via the 0096 substrate (reason `Moderated`), keyed to the
		// first open report id captured above.
		const reportId = firstOpenId ?? input.reportId ?? targetKey(target.targetKind, target.targetId);
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

// The post-gate wave-restore body — `Moderate`-gated in R like {@link restoreGated}. It
// generalizes the single-target restore across the batch: bring EVERY target sharing the
// waveId back live (the same per-target `moderateRestore` + live re-append the lone restore
// runs), then reopen the whole batch as a unit (`reopenForWave`). The batch is exactly the
// wave — one shared id — so nothing outside it is touched. `yield* Moderate` IS the gate.
const restoreWaveGated = Effect.fn("report.restoreWaveGated")(function* (
	input: typeof RestoreWaveReportInput.Type,
) {
	yield* Moderate;
	const report = yield* Report;
	const live = reportLive(yield* WorkerLivePublisher, yield* PanoFeedCache);

	// The batch's still-terminal targets — each gets its content brought back live, exactly
	// as the single restore does, before the reports flip open.
	const targets = yield* report.waveTargets(input.waveId);
	for (const target of targets) {
		const restored = yield* moderateRestore(target);
		if (restored.restored) {
			yield* publishRestored(live, target, restored.sandboxedAt);
		}
	}

	// Reopen every report sharing the waveId together — the restore-as-a-unit primitive.
	const {reopened} = yield* report.reopenForWave(input.waveId);

	// A result-only ack (like the single restore): the wave carries no single target, so the
	// receipt names the wave (`waveId` as the id) and reports how many reports reopened.
	const first = targets[0];
	return toResolveReceipt({
		targetKind: first?.targetKind ?? "post",
		targetId: input.waveId,
		resolution: "dismissed",
		targetRemoved: false,
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
