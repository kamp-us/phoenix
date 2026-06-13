import {useCallback} from "react";
import {useLocation, useNavigate} from "react-router";

/**
 * Build a `/auth?returnTo=<encoded-path>` URL so a signed-out user returns to
 * the exact same view after sign-in. Hash is dropped — Better Auth's redirect
 * strips it anyway.
 */
export function authRedirectPath(returnTo: string): string {
	return `/auth?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Returns `{redirectToAuth}`: routes the signed-out user to the auth page
 * carrying the current path as `returnTo`.
 */
export function useReturnToAuth(): {redirectToAuth: () => void} {
	const navigate = useNavigate();
	const location = useLocation();
	const redirectToAuth = useCallback(() => {
		const path = `${location.pathname}${location.search}`;
		navigate(authRedirectPath(path));
	}, [navigate, location.pathname, location.search]);
	return {redirectToAuth};
}

/**
 * Sanitize a returnTo value before navigating. Only same-origin paths are
 * allowed — anything that doesn't start with `/` (or starts with `//`, which
 * is protocol-relative and could land off-site) falls back to `/`.
 */
export function safeReturnTo(value: string | null | undefined): string {
	if (!value) return "/";
	if (!value.startsWith("/")) return "/";
	if (value.startsWith("//")) return "/";
	return value;
}
