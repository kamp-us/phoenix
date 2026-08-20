/**
 * The bildirim target taxonomy (#1694) — the three content kinds plus `user`.
 * `NOTIFICATION_TARGET_KINDS` is the one runtime tuple the `notification.target_kind` D1
 * enum sources from, so a typo can't compile and write a corrupt row. A target that no
 * longer resolves folds to `null` — a dead row, never a broken link.
 */
import * as Schema from "effect/Schema";
import {TARGET_KINDS} from "../../db/target-kind.ts";

export const NOTIFICATION_TARGET_KINDS = [...TARGET_KINDS, "user"] as const;

export type NotificationTargetKind = (typeof NOTIFICATION_TARGET_KINDS)[number];

export const NotificationTargetKindSchema = Schema.Literals(NOTIFICATION_TARGET_KINDS);

export interface TargetRef {
	readonly targetKind: NotificationTargetKind;
	readonly targetId: string;
}

export const targetRefKey = (kind: NotificationTargetKind, id: string): string => `${kind}:${id}`;

/** Only targets that still resolve appear here; a ref absent from its kind's rows is a tombstone. */
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
 * A comment links to its post's detail page (it has no page of its own); a pre-bootstrap
 * user has no username yet, so it tombstones rather than emitting a broken `/u/null`.
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
