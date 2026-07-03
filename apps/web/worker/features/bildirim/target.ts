/**
 * The bildirim **target taxonomy** (#1694, epic #1666) — what a notification can
 * point at: the three content kinds Vote/Report already span ({@link TARGET_KINDS})
 * plus `user` (a promotion/mod notification targets an account, not a content row).
 * `NOTIFICATION_TARGET_KINDS` is the one runtime tuple the `notification.target_kind`
 * D1 enum sources from, the `TARGET_KINDS` idiom — a typo can't compile and write a
 * corrupt row.
 *
 * The pure target→href core lives here too: {@link foldTargetHrefs} decides, per
 * notification target, the client link (`/pano/…`, `/sozluk/…`, `/u/…`) or `null` —
 * the **tombstone**: a target that no longer resolves (removed content, deleted /
 * unbootstrapped account) renders as a dead row, never a broken link. The DB reads
 * that produce the resolved rows stay in the `Notification` service as the port;
 * this fold is the decision, callable with no engine (ADR 0082 T1/T2).
 */
import * as Schema from "effect/Schema";
import {TARGET_KINDS} from "../../db/target-kind.ts";

export const NOTIFICATION_TARGET_KINDS = [...TARGET_KINDS, "user"] as const;

export type NotificationTargetKind = (typeof NOTIFICATION_TARGET_KINDS)[number];

export const NotificationTargetKindSchema = Schema.Literals(NOTIFICATION_TARGET_KINDS);

/** One notification's target reference — the `(kind, id)` pair the fold resolves. */
export interface TargetRef {
	readonly targetKind: NotificationTargetKind;
	readonly targetId: string;
}

/** The map key for a resolved target — `<kind>:<id>`, the `ReportReceipt` id idiom. */
export const targetRefKey = (kind: NotificationTargetKind, id: string): string => `${kind}:${id}`;

/**
 * The live rows the service's per-kind batch reads produced — only targets that
 * still resolve (`removed_at IS NULL` for content, `deleted_at IS NULL` for users)
 * appear here. A ref absent from its kind's rows is a tombstone.
 */
export interface ResolvedTargetRows {
	readonly post: ReadonlyArray<{id: string}>;
	readonly comment: ReadonlyArray<{id: string; postId: string}>;
	readonly definition: ReadonlyArray<{id: string; termSlug: string}>;
	readonly user: ReadonlyArray<{id: string; username: string | null}>;
}

export const emptyResolvedTargetRows: ResolvedTargetRows = {
	post: [],
	comment: [],
	definition: [],
	user: [],
};

/**
 * Resolve every ref to its client href, or `null` (tombstone). A comment links to
 * its post's detail page (a comment has no page of its own); a user without a
 * username (pre-bootstrap) has no profile URL yet, so it tombstones rather than
 * emitting a broken `/u/null`.
 */
export const foldTargetHrefs = (
	refs: ReadonlyArray<TargetRef>,
	rows: ResolvedTargetRows,
): ReadonlyMap<string, string | null> => {
	const hrefByKey = new Map<string, string | null>();
	for (const row of rows.post) hrefByKey.set(targetRefKey("post", row.id), `/pano/${row.id}`);
	for (const row of rows.comment)
		hrefByKey.set(targetRefKey("comment", row.id), `/pano/${row.postId}`);
	for (const row of rows.definition)
		hrefByKey.set(targetRefKey("definition", row.id), `/sozluk/${row.termSlug}`);
	for (const row of rows.user)
		hrefByKey.set(targetRefKey("user", row.id), row.username ? `/u/${row.username}` : null);

	const resolved = new Map<string, string | null>();
	for (const ref of refs) {
		const key = targetRefKey(ref.targetKind, ref.targetId);
		resolved.set(key, hrefByKey.get(key) ?? null);
	}
	return resolved;
};
