/**
 * The bildirim **notification kind** — the closed discriminant naming what kind of
 * moment a notification is (`divan-vote` | `kefil` | `terfi` | `reply` | `vote` |
 * `report-filed` | `caylak-pending`), the `TARGET_KINDS` /
 * `NOTIFICATION_TARGET_KINDS` idiom (`target-kind.ts` / `target.ts`).
 *
 * `NOTIFICATION_KINDS` is the one runtime tuple every emitter const and the client
 * copy map source from, so the kind can no longer be independent string literals
 * that silently drift: the emitters (`REPLY_KIND`, `DIVAN_VOTE_KIND`, `KEFIL_KIND`,
 * `PROMOTION_KIND`, `VOTE_KIND`, `REPORT_FILED_KIND`, `CAYLAK_PENDING_KIND`) type
 * against this union, and the client `KIND_COPY` map is
 * `satisfies Record<NotificationKind, …>` — so shipping a new kind without its
 * Turkish copy is a compile error, not a raw wire identifier rendered to a reader
 * (the `reply` drift, #2016).
 *
 * `vote` (#1698) is the aggregated live-content vote moment — a vote on a member's
 * pano post/comment or sözlük definition — kept DISTINCT from divan's sandboxed
 * `divan-vote` so the two surfaces carry their own product voice ("N yeni oy" vs
 * "divandaki içeriğin oy aldı"). The mod-facing kinds (`report-filed` /
 * `caylak-pending`, #1699) are the moderator queue's heartbeat.
 */

/** The closed notification-kind set, as the one runtime tuple emitters + copy source from. */
export const NOTIFICATION_KINDS = [
	"divan-vote",
	"kefil",
	"terfi",
	"reply",
	"vote",
	"report-filed",
	"caylak-pending",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
