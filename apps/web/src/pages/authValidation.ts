/**
 * Turkish client-side field validation for the auth form (`AuthPage`). The form
 * carries `noValidate`, so the browser's locale-default constraint bubbles ("Please
 * fill out this field.") never fire — these pure checks drive the same required/format
 * constraints through the existing `kp-auth__error` surface in Turkish instead.
 *
 * Username is validated separately by `localRuleMessage` (`usernameMessages.ts`), the
 * single-source `checkUsername` rule the server also enforces; these cover the plain
 * credential fields (görünen ad · e-posta · parola).
 */

// A pragmatic HTML5-ish email shape: one `@`, a dot-bearing domain, no spaces. It is
// a UX pre-flight, not the authority — the server still validates on signUp/signIn.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minimum password length — mirrors better-auth's signup policy. */
const PASSWORD_MIN = 8;

export function validateName(value: string): string | null {
	return value.trim() ? null : "görünen ad gerekli";
}

export function validateEmail(value: string): string | null {
	const v = value.trim();
	if (!v) return "e-posta gerekli";
	if (!EMAIL_RE.test(v)) return "geçerli bir e-posta gir";
	return null;
}

/**
 * Sign-up enforces the length floor (a new password must clear the policy); sign-in
 * only requires a non-empty value, since an existing password's length is the
 * server's business and revealing the floor to a login attempt is pointless.
 */
export function validatePassword(value: string, mode: "sign-in" | "sign-up"): string | null {
	if (!value) return "parola gerekli";
	if (mode === "sign-up" && value.length < PASSWORD_MIN) return "parola en az 8 karakter olmalı";
	return null;
}

/** First failing credential message in field order, or `null` when all pass. */
export function validateSignIn(email: string, password: string): string | null {
	return validateEmail(email) ?? validatePassword(password, "sign-in");
}

/** First failing message for the non-username signup fields, in visual field order. */
export function validateSignUp(name: string, email: string, password: string): string | null {
	return validateName(name) ?? validateEmail(email) ?? validatePassword(password, "sign-up");
}
