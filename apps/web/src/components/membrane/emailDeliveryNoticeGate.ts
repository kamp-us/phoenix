/**
 * Membrane email-delivery notice — the pure seam (email-bounce epic #2687, Child #2693).
 *
 * A signed-in user whose transactional address is failing gets no magic-link/verification
 * mail and, until now, no signal why. This surfaces that state on the membrane shell with a
 * recovery affordance. The failing signal is the user's OWN projected `email-delivery` state
 * (`resolveEmailDeliveryState`, Child #2691); the recovery CTA reuses the EXISTING change-email
 * flow (no new recovery backend).
 */

/**
 * The forward-compatible shape the notice reads the failing signal off — a widening of the
 * `me` row that is inert until the worker exposes `emailFailing` on the pasaport `User` wire
 * view (Child #2693 AC1, a worker read-surface change sequenced with admin Child #2692). A
 * plain `me` (no such field yet) is structurally assignable here, so `readEmailFailing` reads
 * `false` today and the notice never renders; the moment the worker stamps `emailFailing` onto
 * the `me` row it lights up with no further client change.
 */
export interface EmailDeliveryReadable {
	readonly emailFailing?: boolean;
}

/** The user's own projected failing-delivery signal — absent (not-yet-wired) reads as deliverable. */
export const readEmailFailing = (me: EmailDeliveryReadable | null): boolean =>
	me?.emailFailing ?? false;

/**
 * The account surface the recovery CTA routes into: the existing profile/account page, whose
 * `e-posta` row owns the change-email affordance. Reusing it keeps the CTA off a NEW recovery
 * mechanism (epic #2687 non-goal) — the change-email confirmation path itself already exists via
 * better-auth (ADR 0101).
 */
export const EMAIL_RECOVERY_HREF = "/profile";

/** Whether the membrane notice renders: gated on the dark-ship flag, the failing signal, and not-yet-dismissed. */
export const shouldShowEmailDeliveryNotice = (input: {
	readonly flagOn: boolean;
	readonly failing: boolean;
	readonly dismissed: boolean;
}): boolean => input.flagOn && input.failing && !input.dismissed;
