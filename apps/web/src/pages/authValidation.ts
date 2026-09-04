/**
 * The auth form carries `noValidate` — the browser's own constraint bubbles never fire — so these
 * hand-rolled checks are the only client-side ones that run. Username is validated separately, by
 * the single-source rule in `usernameMessages.ts`.
 *
 * These return a `CatalogKey`, not a message: the checks are pure and locale-free, and `AuthPage`
 * translates whatever key comes back (ADR 0347).
 */
import type {CatalogKey} from "../i18n";

// Deliberately loose: a UX pre-flight, not the authority. The server still validates.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors better-auth's signup policy. */
const PASSWORD_MIN = 8;

export function validateName(value: string): CatalogKey | null {
	return value.trim() ? null : "auth.validation.nameRequired";
}

export function validateEmail(value: string): CatalogKey | null {
	const v = value.trim();
	if (!v) return "auth.validation.emailRequired";
	if (!EMAIL_RE.test(v)) return "auth.validation.emailInvalid";
	return null;
}

/** Sign-in skips the length floor on purpose: don't reveal the policy to a login attempt. */
export function validatePassword(value: string, mode: "sign-in" | "sign-up"): CatalogKey | null {
	if (!value) return "auth.validation.passwordRequired";
	if (mode === "sign-up" && value.length < PASSWORD_MIN) return "auth.validation.passwordTooShort";
	return null;
}

export function validateSignIn(email: string, password: string): CatalogKey | null {
	return validateEmail(email) ?? validatePassword(password, "sign-in");
}

export function validateSignUp(name: string, email: string, password: string): CatalogKey | null {
	return validateName(name) ?? validateEmail(email) ?? validatePassword(password, "sign-up");
}
