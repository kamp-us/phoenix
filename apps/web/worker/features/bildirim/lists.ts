/**
 * `bildirim.list` — the current user's notifications, newest-first, forward
 * keyset pagination (ADR 0019; the service owns the cursor). Flag-gated
 * ({@link requireBildirimOn}, the invisible `Denied` while dark); signed-out
 * resolves to an empty connection (the read-path "degrade, never throw"
 * convention of `savedPosts`). Each node carries the server-resolved
 * `targetUrl` — `null` for a target that no longer resolves, so the client
 * renders a tombstone, never a broken link.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {emptyKeysetPage} from "../../db/keyset.ts";
import {toConnection} from "../fate/connection.ts";
import {Denied} from "../kunye/errors.ts";
import {requireBildirimOn} from "./gate.ts";
import {Notification, type NotificationRow} from "./Notification.ts";
import {toNotification} from "./shapers.ts";
import {targetRefKey} from "./target.ts";
import type {Notification as NotificationEntity} from "./views.ts";
import {NotificationView} from "./views.ts";

const ListArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

export const lists = {
	"bildirim.list": Fate.list(
		{
			args: ListArgs,
			type: NotificationView,
			error: Schema.Union([Denied]),
		},
		Effect.fn("bildirim.list")(function* ({args}) {
			yield* requireBildirimOn;
			const {user} = yield* CurrentUser;
			const viewerId = user?.id ?? null;
			if (!viewerId) {
				return toConnection<NotificationRow, NotificationEntity>(
					emptyKeysetPage,
					(row) => row.id,
					(row) => toNotification(row, null),
				);
			}

			const bildirim = yield* Notification;
			const page = yield* bildirim.listForRecipient(viewerId, {
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
			});
			const hrefs = yield* bildirim.resolveTargets(
				page.rows.map((row) => ({targetKind: row.targetKind, targetId: row.targetId})),
			);

			return toConnection<NotificationRow, NotificationEntity>(
				page,
				(row) => row.id,
				(row) => toNotification(row, hrefs.get(targetRefKey(row.targetKind, row.targetId)) ?? null),
			);
		}),
	),
};
