/**
 * Report mutation resolvers (ADR 0098):
 *
 * - `report.submit` — the capture-side write. `CurrentUser.required` gates it; the
 *   handler returns a `ReportReceipt` ack and translates the service's kind-blind
 *   `ReportTargetNotFound` into the per-feature not-found the wire knows.
 * - `report.resolve` — the moderation-side write. `Moderator.required` gates it
 *   (anonymous or non-moderator → `UNAUTHORIZED`, so the surface is invisible to
 *   non-moderators); on `removed` it calls the content service's moderator-remove,
 *   reusing the 0096 substrate with reason `Moderated({reportId})`, then collapses
 *   EVERY open report on the target with the audit triad. The state machine in
 *   `resolution.ts` keeps an illegal transition unrepresentable.
 *
 * Both acks are returned inline (the interpreter stamps `__typename` only on
 * source-resolved entities), so the handlers shape them through the shapers.
 * See `.patterns/fate-effect-operations.md`.
 */

import {CurrentUser, Fate, Unauthorized} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {CommentNotFound, PostNotFound} from "../pano/errors.ts";
import {Pano} from "../pano/Pano.ts";
import {DefinitionNotFound} from "../sozluk/errors.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import type {ReportTargetKind, ReportTargetNotFound} from "./errors.ts";
import {Moderator, NotAModerator} from "./Moderator.ts";
import {Report} from "./Report.ts";
import {toReportReceipt, toResolveReceipt} from "./shapers.ts";
import {ReportReceiptView, ResolveReceiptView} from "./views.ts";

const SubmitReportInput = Schema.Struct({
	targetKind: Schema.Literals(["definition", "post", "comment"]),
	targetId: Schema.String,
	reason: Schema.optional(Schema.NullOr(Schema.String)),
});

// Either name the target directly (the moderation queue surfaces `targetKind` +
// `targetId`), or pass a `reportId` and the resolve acts on its whole target group.
const ResolveReportInput = Schema.Struct({
	reportId: Schema.optional(Schema.String),
	targetKind: Schema.optional(Schema.Literals(["definition", "post", "comment"])),
	targetId: Schema.optional(Schema.String),
	action: Schema.Literals(["removed", "dismissed"]),
});

const RestoreReportInput = Schema.Struct({
	reportId: Schema.optional(Schema.String),
	targetKind: Schema.optional(Schema.Literals(["definition", "post", "comment"])),
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
			error: Schema.Union([Unauthorized, NotAModerator]),
		},
		Effect.fn("report.resolve")(function* ({input}) {
			const mod = yield* Moderator.required;
			const report = yield* Report;

			// Resolve the target: a `reportId` resolves to its `(targetKind, targetId)`;
			// otherwise `targetKind` + `targetId` are taken directly.
			let target: {targetKind: ReportTargetKind; targetId: string} | null = null;
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
					resolution: input.action,
					targetRemoved: false,
					collapsed: 0,
				});
			}

			const now = new Date();
			let targetRemoved = false;

			if (input.action === "removed") {
				// Act on the target via the 0096 substrate (reason `Moderated`); the
				// reportId carried into the removal is the FIRST open report id on the
				// target, so a later restore can reopen the group.
				const firstId = yield* report.firstOpenReportId(target.targetKind, target.targetId);
				const reportId = firstId ?? input.reportId ?? `${target.targetKind}:${target.targetId}`;
				const removed = yield* moderateRemove(target, mod.id, reportId);
				targetRemoved = removed;
			}

			const {collapsed} = yield* report.resolveTarget({
				targetKind: target.targetKind,
				targetId: target.targetId,
				resolverId: mod.id,
				resolution: input.action,
				resolvedAt: now,
			});

			return toResolveReceipt({
				targetKind: target.targetKind,
				targetId: target.targetId,
				resolution: input.action,
				targetRemoved,
				collapsed,
			});
		}),
	),

	// The reopen edge (ADR 0098 §3 / 0096 §4): a moderator restore of a removed
	// target brings the content back live AND reopens its reports (the bounded
	// reopen). `Moderator.required`-gated, like resolve.
	"report.restore": Fate.mutation(
		{
			input: RestoreReportInput,
			type: ResolveReceiptView,
			error: Schema.Union([Unauthorized, NotAModerator]),
		},
		Effect.fn("report.restore")(function* ({input}) {
			yield* Moderator.required;
			const report = yield* Report;

			let target: {targetKind: ReportTargetKind; targetId: string} | null = null;
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
			const {reopened} = yield* report.reopenForTarget(target);

			return toResolveReceipt({
				targetKind: target.targetKind,
				targetId: target.targetId,
				resolution: "dismissed",
				targetRemoved: !restored,
				collapsed: reopened,
			});
		}),
	),
};

/** Dispatch act-on-target to the content service that owns the target kind. */
const moderateRemove = Effect.fn("report.moderateRemove")(function* (
	target: {targetKind: ReportTargetKind; targetId: string},
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

/** Dispatch the moderator restore to the content service that owns the target kind. */
const moderateRestore = Effect.fn("report.moderateRestore")(function* (target: {
	targetKind: ReportTargetKind;
	targetId: string;
}) {
	switch (target.targetKind) {
		case "definition": {
			const sozluk = yield* Sozluk;
			const {restored} = yield* sozluk.moderateRestoreDefinition({definitionId: target.targetId});
			return restored;
		}
		case "post": {
			const pano = yield* Pano;
			const {restored} = yield* pano.moderateRestorePost({postId: target.targetId});
			return restored;
		}
		case "comment": {
			const pano = yield* Pano;
			const {restored} = yield* pano.moderateRestoreComment({commentId: target.targetId});
			return restored;
		}
	}
});
