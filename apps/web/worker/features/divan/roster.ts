/**
 * The pure divan read-model shaping (#1287, epic #1202) — no service, no Effect, so
 * the roster grouping is unit-testable on its own.
 *
 * The divan is a yazar-OR-mod-gated DESTINATION over the `sandboxBacklogWhere` read
 * model (#1205), NOT a widening of the inline `{mod, author}` visibility. The grouping
 * here makes the roster's unit the PERSON, not the item.
 */

import type {TargetKind} from "../../db/target-kind.ts";
import type {UserId} from "../../lib/ids.ts";

// Aliased to {@link TargetKind} so a divan kind outside `TARGET_KINDS` cannot compile
// against the vote/report engines the divan casts into.
export type DivanItemKind = TargetKind;

// `id` is the domain row id; the fate view keys it `<kind>:<id>` so the three kinds
// never collide in one connection.
export interface DivanItem {
	readonly kind: DivanItemKind;
	readonly id: string;
	readonly authorId: UserId;
	readonly createdAt: Date;
	readonly preview: string;
}

export interface DivanCaylakEntry {
	readonly authorId: UserId;
	readonly definitionCount: number;
	readonly postCount: number;
	readonly commentCount: number;
	readonly totalCount: number;
}

// Joined onto the counts by a SINGLE batched profile read, so no per-row by-id
// `Profile` read happens on the client (ADR 0021's no-waterfalls contract, #1423).
// Deliberately minimal — never widen `Profile` onto this mod-gated surface. The
// nullable handles fall back to the bare "çaylak" label client-side.
export interface CaylakIdentityFields {
	readonly username: string | null;
	readonly displayName: string | null;
	readonly totalKarma: number;
}

export type DivanRosterRow = DivanCaylakEntry & CaylakIdentityFields;

/**
 * Group backlog items by author. Sorted by total pending desc then authorId, for a
 * stable order.
 *
 * A blank authorId is skipped: the moderator-backlog read blanks the author of an
 * author-deleted-but-not-removed row (ADR 0096), which is not a real çaylak's pending
 * work and must not seed an empty-author group. Removed/live items are excluded
 * upstream by `sandboxBacklogWhere`, never re-judged here.
 */
export const buildRoster = (items: ReadonlyArray<DivanItem>): ReadonlyArray<DivanCaylakEntry> => {
	const byAuthor = new Map<UserId, {definitions: number; posts: number; comments: number}>();
	for (const item of items) {
		if (item.authorId === "") continue;
		const counts = byAuthor.get(item.authorId) ?? {definitions: 0, posts: 0, comments: 0};
		if (item.kind === "definition") counts.definitions += 1;
		else if (item.kind === "post") counts.posts += 1;
		else counts.comments += 1;
		byAuthor.set(item.authorId, counts);
	}
	return [...byAuthor.entries()]
		.map(([authorId, c]): DivanCaylakEntry => {
			const totalCount = c.definitions + c.posts + c.comments;
			return {
				authorId,
				definitionCount: c.definitions,
				postCount: c.posts,
				commentCount: c.comments,
				totalCount,
			};
		})
		.sort((a, b) => b.totalCount - a.totalCount || (a.authorId < b.authorId ? -1 : 1));
};
