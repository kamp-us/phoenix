/**
 * The auth form carries `noValidate` — the browser's English constraint bubbles never
 * fire — so these hand-rolled checks are the only client-side ones that run. Username is
 * validated separately, by the single-source rule in `usernameMessages.ts`.
 */

// Deliberately loose: a UX pre-flight, not the authority. The server still validates.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors better-auth's signup policy. */
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

/** Sign-in skips the length floor on purpose: don't reveal the policy to a login attempt. */
export function validatePassword(value: string, mode: "sign-in" | "sign-up"): string | null {
	if (!value) return "parola gerekli";
	if (mode === "sign-up" && value.length < PASSWORD_MIN) return "parola en az 8 karakter olmalı";
	return null;
}

export function validateSignIn(email: string, password: string): string | null {
	return validateEmail(email) ?? validatePassword(password, "sign-in");
}

export function validateSignUp(name: string, email: string, password: string): string | null {
	return validateName(name) ?? validateEmail(email) ?? validatePassword(password, "sign-up");
}
