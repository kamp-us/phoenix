/**
 * Failing-address delivery-state domain (email-bounce epic #2687). Pure logic, no I/O:
 * the current per-address delivery-state is a PROJECTION of the append-only
 * `email_delivery_event` log — the latest event decides, so state can never drift from
 * history and a stale "bouncing flag" is unrepresentable. This mirrors `resolveBanState`
 * (`ban.ts`, ADR 0107) verbatim: a projection over an append-only log.
 *
 * Today's only feed is the send-time capture (Child #2691); the honest limit of that
 * signal is stated where it is captured (`email-sender.ts`). The admin mark/clear (Child
 * #2692) and the CF async ingestion (Child #2694) append to the same log.
 */

/** The two event kinds appended to the log: a `fail` opens a failing-state, a `clear` lifts it. */
export type EmailDeliveryEventAction = "fail" | "clear";

/** One row of the append-only delivery log, as the projection needs it. */
export interface EmailDeliveryEvent {
	readonly action: EmailDeliveryEventAction;
	readonly reason: string | null;
	readonly createdAt: Date;
}

/** The projected current delivery-state for one address. */
export interface EmailDeliveryState {
	readonly failing: boolean;
	/** The active failure's reason, or null when deliverable. */
	readonly reason: string | null;
}

/** The deliverable state — an address with no events, or one whose latest event is a `clear`. */
export const DELIVERABLE: EmailDeliveryState = {failing: false, reason: null};

/**
 * Project the current delivery-state from the address's LATEST event.
 *
 * The caller passes the single newest event (by `createdAt`) or null when the log is
 * empty. Failing iff that latest event is a `fail` — so a `clear` after a `fail` restores
 * deliverability without touching the fail row (full reversibility, as in `resolveBanState`).
 * `now` is carried for signature parity with `resolveBanState` and to leave room for a
 * future time-decayed failing-state (Child #2694); today's send-rejection signal has no
 * expiry, so it is not read.
 */
export const resolveEmailDeliveryState = (
	latest: EmailDeliveryEvent | null,
	now: Date,
): EmailDeliveryState => {
	void now;
	if (latest === null || latest.action === "clear") return DELIVERABLE;
	return {failing: true, reason: latest.reason};
};

/**
 * One append-only log row as the admin failing-address roll-up (Child #2692) needs it:
 * the projection fields plus the address/user the row is keyed by and the server
 * `id`/`createdAt` ordering pair used to pick the latest event per address.
 */
export interface EmailDeliveryEventRow extends EmailDeliveryEvent {
	readonly id: string;
	readonly address: string;
	readonly userId: string | null;
}

/** One currently-failing address in the admin roll-up — the address, who it resolves to, and why. */
export interface FailingAddress {
	readonly address: string;
	readonly userId: string | null;
	readonly reason: string | null;
	/** The `createdAt` of the active `fail` event — when the address started failing. */
	readonly since: Date;
}

// Latest wins by (createdAt, id) — the same server-assigned ordering the ban read and
// the per-address index (`email_delivery_event_address_created`) resolve by, so the pure
// roll-up and a DB `ORDER BY … DESC LIMIT 1` per address agree.
const isNewer = (a: EmailDeliveryEventRow, b: EmailDeliveryEventRow): boolean => {
	const at = a.createdAt.getTime();
	const bt = b.createdAt.getTime();
	return at !== bt ? at > bt : a.id > b.id;
};

/**
 * The admin failing-address projection (Child #2692): the set of addresses whose LATEST
 * event is a `fail`, derived from the SAME append-only log the send-time capture and the
 * per-address `resolveEmailDeliveryState` read — never a separate stored flag. Reduces the
 * rows to the newest event per address, keeps those that project to `failing`, and orders
 * them newest-failing first. Pure over the full failure log (which is small — only send
 * rejections and admin marks land here, not every send), so the roll-up is unit-testable
 * without D1.
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
