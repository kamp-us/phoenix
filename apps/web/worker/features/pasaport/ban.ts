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

/** One ban-log row tagged with the account it belongs to — the batch projection's input. */
export interface UserBanEvent extends BanEvent {
	/** The account the event was appended for. */
	readonly userId: string;
	/** The event's own id — the same-instant tiebreak the single read uses (`created_at DESC, id DESC`). */
	readonly id: string;
}

/**
 * The batched form of {@link resolveBanState}: project the current ban-state for MANY
 * accounts from a flat slice of the append-only `user_ban_event` log, so an admin roster
 * reads one query's worth of events and folds it here instead of an N+1 per-row read. The
 * same latest-event-wins rule as the single read — group by `userId`, pick the newest event
 * (by `createdAt`, tie-broken by `id`, matching the single read's `ORDER BY created_at DESC,
 * id DESC`), then {@link resolveBanState}. A user id with no event is simply absent from the
 * map; the caller reads it as {@link NOT_BANNED}.
 */
export const selectBanStates = (
	events: ReadonlyArray<UserBanEvent>,
	now: Date,
): Map<string, BanState> => {
	const latest = new Map<string, UserBanEvent>();
	for (const event of events) {
		const current = latest.get(event.userId);
		const newer =
			!current ||
			event.createdAt.getTime() > current.createdAt.getTime() ||
			(event.createdAt.getTime() === current.createdAt.getTime() && event.id > current.id);
		if (newer) latest.set(event.userId, event);
	}
	const states = new Map<string, BanState>();
	for (const [userId, event] of latest) states.set(userId, resolveBanState(event, now));
	return states;
};
