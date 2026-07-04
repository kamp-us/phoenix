/**
 * The bildirim **notification kind** — the closed discriminant naming what kind of
 * moment a notification is (`divan-vote` | `kefil` | `terfi` | `reply`), the
 * `TARGET_KINDS` / `NOTIFICATION_TARGET_KINDS` idiom (`target-kind.ts` / `target.ts`).
 *
 * `NOTIFICATION_KINDS` is the one runtime tuple every emitter const and the client
 * copy map source from, so the kind can no longer be four independent string
 * literals that silently drift: the emitters (`REPLY_KIND`, `DIVAN_VOTE_KIND`,
 * `KEFIL_KIND`, `PROMOTION_KIND`) type against this union, and the client
 * `KIND_COPY` map is `satisfies Record<NotificationKind, …>` — so shipping a fifth
 * kind without its Turkish copy is a compile error, not a raw wire identifier
 * rendered to a reader (the `reply` drift, #2016).
 */

/** The closed notification-kind set, as the one runtime tuple emitters + copy source from. */
export const NOTIFICATION_KINDS = ["divan-vote", "kefil", "terfi", "reply"] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
