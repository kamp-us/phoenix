// A widening of the `me` row that stays inert until the worker exposes `emailFailing` on the
// pasaport `User` wire view: a plain `me` is structurally assignable, so the notice reads
// `false` and never renders today, and lights up with no client change once the field lands.
export interface EmailDeliveryReadable {
	readonly emailFailing?: boolean;
}

export const readEmailFailing = (me: EmailDeliveryReadable | null): boolean =>
	me?.emailFailing ?? false;

// The CTA reuses the profile page's existing change-email row — building a NEW recovery
// mechanism is an epic #2687 non-goal.
export const EMAIL_RECOVERY_HREF = "/profile";

export const shouldShowEmailDeliveryNotice = (input: {
	readonly flagOn: boolean;
	readonly failing: boolean;
	readonly dismissed: boolean;
}): boolean => input.flagOn && input.failing && !input.dismissed;
