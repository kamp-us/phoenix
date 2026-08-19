/**
 * Ban-state domain (ADR 0107). Pure logic, no I/O: the current ban-state is a
 * PROJECTION of the append-only `user_ban_event` log — the latest event decides, so a
 * stale "banned flag" is unrepresentable. Enforcement and the ban/unban writes both run
 * this projection, so the boundary that refuses a session and the surface that reports
 * ban-state can't disagree.
 */

export type BanEventAction = "ban" | "unban";

export interface BanEvent {
	readonly action: BanEventAction;
	readonly reason: string | null;
	readonly expiresAt: Date | null;
	readonly createdAt: Date;
}

export interface BanState {
	readonly banned: boolean;
	/** The active ban's reason, or null when not banned. */
	readonly reason: string | null;
	/** The active ban's expiry (null = permanent), or null when not banned. */
	readonly expiresAt: Date | null;
}

export const NOT_BANNED: BanState = {banned: false, reason: null, expiresAt: null};

/**
 * Project the current ban-state from the account's LATEST ban event (or null on an
 * empty log). An `unban` lifts a ban and an elapsed `expiresAt` self-lifts it, both
 * without touching the ban row. Fail-open on equality: `expiresAt <= now` ⇒ lifted.
 */
export const resolveBanState = (latest: BanEvent | null, now: Date): BanState => {
	if (latest === null || latest.action === "unban") return NOT_BANNED;
	if (latest.expiresAt !== null && latest.expiresAt.getTime() <= now.getTime()) return NOT_BANNED;
	return {banned: true, reason: latest.reason, expiresAt: latest.expiresAt};
};

export interface UserBanEvent extends BanEvent {
	readonly userId: string;
	/** The same-instant tiebreak, matching the single read's `ORDER BY created_at DESC, id DESC`. */
	readonly id: string;
}

/**
 * The batched form of {@link resolveBanState}, so an admin roster folds one query's
 * events instead of an N+1 per-row read. Same latest-event-wins rule. A user id with no
 * event is absent from the map; the caller reads that as {@link NOT_BANNED}.
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
