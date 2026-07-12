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
