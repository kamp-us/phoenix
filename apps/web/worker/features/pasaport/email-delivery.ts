/**
 * Failing-address delivery state (email-bounce epic #2687). Pure logic, no I/O: the
 * per-address state is a PROJECTION of the append-only `email_delivery_event` log, so it
 * can never drift from history and a stale "bouncing flag" is unrepresentable. Mirrors
 * `resolveBanState` (`ban.ts`, ADR 0107).
 */

export type EmailDeliveryEventAction = "fail" | "clear";

export interface EmailDeliveryEvent {
	readonly action: EmailDeliveryEventAction;
	readonly reason: string | null;
	readonly createdAt: Date;
}

export interface EmailDeliveryState {
	readonly failing: boolean;
	/** The active failure's reason, or null when deliverable. */
	readonly reason: string | null;
}

export const DELIVERABLE: EmailDeliveryState = {failing: false, reason: null};

/**
 * `latest` is the single newest event by `createdAt`, or null on an empty log. A `clear`
 * after a `fail` restores deliverability without touching the fail row. `now` is unread
 * today — carried for parity with `resolveBanState` and a future time-decayed state (#2694).
 */
export const resolveEmailDeliveryState = (
	latest: EmailDeliveryEvent | null,
	now: Date,
): EmailDeliveryState => {
	void now;
	if (latest === null || latest.action === "clear") return DELIVERABLE;
	return {failing: true, reason: latest.reason};
};

export interface EmailDeliveryEventRow extends EmailDeliveryEvent {
	readonly id: string;
	readonly address: string;
	readonly userId: string | null;
}

export interface FailingAddress {
	readonly address: string;
	readonly userId: string | null;
	readonly reason: string | null;
	/** The `createdAt` of the active `fail` event — when the address started failing. */
	readonly since: Date;
}

// Ties break on `id` so this pure roll-up and a DB `ORDER BY … DESC LIMIT 1` agree.
const isNewer = (a: EmailDeliveryEventRow, b: EmailDeliveryEventRow): boolean => {
	const at = a.createdAt.getTime();
	const bt = b.createdAt.getTime();
	return at !== bt ? at > bt : a.id > b.id;
};

/**
 * The admin roll-up (#2692), derived from the SAME log as the per-address read — never a
 * separate stored flag. Pure over the whole log, which is safe because only rejections and
 * admin marks land there, not every send.
 */
export const selectFailingAddresses = (
	rows: ReadonlyArray<EmailDeliveryEventRow>,
	now: Date,
): ReadonlyArray<FailingAddress> => {
	const latest = new Map<string, EmailDeliveryEventRow>();
	for (const row of rows) {
		const seen = latest.get(row.address);
		if (!seen || isNewer(row, seen)) latest.set(row.address, row);
	}
	const failing: FailingAddress[] = [];
	for (const row of latest.values()) {
		const state = resolveEmailDeliveryState(row, now);
		if (state.failing) {
			failing.push({
				address: row.address,
				userId: row.userId,
				reason: state.reason,
				since: row.createdAt,
			});
		}
	}
	return failing.sort((a, b) => b.since.getTime() - a.since.getTime());
};
