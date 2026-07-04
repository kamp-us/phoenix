/**
 * The pure divan read-model shaping (#1287, epic #1202) — no service, no Effect,
 * so the roster grouping is unit-testable in isolation (ADR 0082 unit tier).
 *
 * The divan is the çaylak→yazar proving ground: a yazar-OR-mod-gated DESTINATION
 * over the shipped `sandboxBacklogWhere` read model (#1205), NOT a widening of the
 * inline `{mod, author}` visibility. {@link Divan} fetches each çaylak's
 * still-sandboxed, not-removed backlog through the existing `listSandboxed*`
 * service reads (which compose `sandboxBacklogWhere`); the shaping here groups
 * those loose items by author so the roster's unit is the **person**, not the item.
 *
 * Two shapes:
 *   - {@link DivanItem} — one normalized sandboxed backlog item (the per-kind
 *     definition/post/comment rows collapsed onto a common `{kind, id, authorId,
 *     createdAt, preview}` shape the detail view #1290 renders).
 *   - {@link DivanCaylakEntry} — one roster row: a çaylak with ≥1 pending item plus
 *     the per-kind counts. {@link buildRoster} derives these by grouping items.
 */

import type {TargetKind} from "../../db/target-kind.ts";

/**
 * The content kind a sandboxed backlog item came from. Aliased to the shared
 * {@link TargetKind} taxonomy so the votable-kind set is declared once — a divan
 * kind outside `TARGET_KINDS` can no longer be introduced here without failing to
 * compile against the vote/report engines the divan casts into.
 */
export type DivanItemKind = TargetKind;

/**
 * One normalized sandboxed backlog item — the per-domain rows
 * (`DefinitionRow`/`PostSummaryRow`/`CommentRow`) collapsed onto the common fields
 * the divan needs. `id` is the domain row id; the fate view keys it `<kind>:<id>`
 * so the three kinds never collide in one connection.
 */
export interface DivanItem {
	readonly kind: DivanItemKind;
	readonly id: string;
	readonly authorId: string;
	readonly createdAt: Date;
	/** A short text preview for the queue row (body / title), never the full node. */
	readonly preview: string;
}

/**
 * One roster row: a çaylak with at least one pending (sandboxed, not-removed) item,
 * plus the per-kind counts. The unit is the **person** — loose items are read
 * separately as that çaylak's backlog (`Divan.backlogOf`).
 */
export interface DivanCaylakEntry {
	readonly authorId: string;
	readonly definitionCount: number;
	readonly postCount: number;
	readonly commentCount: number;
	/** definitions + posts + comments — the headline "pending work" count. */
	readonly totalCount: number;
}

/**
 * The identity a roster row carries about its çaylak — the display handle
 * (`displayName`/`username`) + their karma-on-others. Joined onto the counts in
 * `Divan.roster` via a SINGLE batched profile read, so the roster's one fate request
 * resolves every row's identity in-batch — no per-row by-id `Profile` read on the
 * client (ADR 0021's no-waterfalls contract, #1423). Deliberately minimal: only the
 * fields the roster row renders, never a widening of `Profile` onto this mod-gated
 * surface. `username`/`displayName` are nullable (a çaylak may not have set a username
 * yet); the client falls back to the bare "çaylak" label.
 */
export interface CaylakIdentityFields {
	readonly username: string | null;
	readonly displayName: string | null;
	readonly totalKarma: number;
}

/**
 * A roster row as delivered to the client: the per-kind counts + the çaylak's
 * identity, both resolved in the same batched read.
 */
export type DivanRosterRow = DivanCaylakEntry & CaylakIdentityFields;

/**
 * Group sandboxed backlog items by author into the pending-çaylak roster. Only
 * authors with ≥1 item appear (a person with no pending work is not on the queue),
 * sorted by total pending desc then authorId for a stable order. Items with a blank
 * authorId are skipped — the moderator-backlog read blanks the author of an
 * author-deleted-but-not-removed row (ADR 0096), which is not a real çaylak's
 * pending work and must not seed an empty-author roster group.
 *
 * The caller hands items that already passed `sandboxBacklogWhere` (sandboxed +
 * `removed_at IS NULL`), so removed/live items are excluded upstream, not re-judged
 * here.
 */
export const buildRoster = (items: ReadonlyArray<DivanItem>): ReadonlyArray<DivanCaylakEntry> => {
	const byAuthor = new Map<string, {definitions: number; posts: number; comments: number}>();
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
