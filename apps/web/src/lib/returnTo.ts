import {useCallback} from "react";
import {useLocation, useNavigate} from "react-router";

/**
 * Build a `/auth?returnTo=<encoded-path>` URL from the current browser
 * location. Used by every write affordance (vote, add definition, submit
 * post, add comment, edit, delete) when invoked by a signed-out user.
 *
 * The full path + search lives in `returnTo` so the user comes back to the
 * exact same view (e.g. a post detail with a hash fragment) after sign-in.
 * Hash is dropped because Better Auth's redirect strips it anyway.
 */
export function authRedirectPath(returnTo: string): string {
	return `/auth?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Hook that returns `{redirectToAuth}`: invoke without args to route the
 * signed-out user to the auth page carrying the current path as `returnTo`.
 * Mirrors the ad-hoc `navigate(`/auth?returnTo=…`)` snippets sprinkled
 * across the codebase (T4–T12); centralizing it means future write
 * surfaces can opt in with a single import.
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
