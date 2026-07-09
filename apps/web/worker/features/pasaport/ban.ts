/**
 * Ban-state domain (epic #968, admin-gated per ADR 0107). Pure logic, no I/O: the
 * current ban-state is a PROJECTION of the append-only `user_ban_event` log — the
 * latest event decides, so state can never drift from the audit history and a stale
 * "banned flag" is unrepresentable. Enforcement (`Pasaport.validateSession`) and the
 * ban/unban writes both run this projection over the same rows, so the boundary that
 * refuses a session and the surface that reports ban-state can't disagree.
 */

/** The two event kinds an admin action appends. */
export type BanEventAction = "ban" | "unban";

/** One row of the append-only ban log, as the projection needs it (audit fields). */
export interface BanEvent {
	readonly action: BanEventAction;
	readonly reason: string | null;
	readonly expiresAt: Date | null;
	readonly createdAt: Date;
}

/** The projected current ban-state for one account. */
export interface BanState {
	readonly banned: boolean;
	/** The active ban's reason, or null when not banned. */
	readonly reason: string | null;
	/** The active ban's expiry (null = permanent), or null when not banned. */
	readonly expiresAt: Date | null;
}

/** The not-banned state — a fresh account, an unbanned one, or an expired ban. */
export const NOT_BANNED: BanState = {banned: false, reason: null, expiresAt: null};

/**
 * Project the current ban-state from the account's LATEST ban event.
 *
 * The caller passes the single newest event (by `createdAt`) or null when the log
 * is empty. Banned iff that latest event is a `ban` whose `expiresAt` is null
 * (permanent) or still in the future at `now` — so an `unban` lifts a ban and an
 * elapsed `expiresAt` self-lifts it, both without touching the ban row. A time
 * boundary is fail-open on equality (`expiresAt <= now` ⇒ lifted): a ban set to
 * expire "now" is done.
 */
export const resolveBanState = (latest: BanEvent | null, now: Date): BanState => {
	if (latest === null || latest.action === "unban") return NOT_BANNED;
	if (latest.expiresAt !== null && latest.expiresAt.getTime() <= now.getTime()) return NOT_BANNED;
	return {banned: true, reason: latest.reason, expiresAt: latest.expiresAt};
};
