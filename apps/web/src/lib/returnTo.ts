import {useCallback} from "react";
import {useLocation, useNavigate} from "react-router";

/** The hash is dropped because Better Auth's redirect strips it anyway. */
export function authRedirectPath(returnTo: string): string {
	return `/auth?returnTo=${encodeURIComponent(returnTo)}`;
}

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
 * Open-redirect guard: only same-origin paths pass. `//` is rejected too — it is
 * protocol-relative and would land off-site.
 */
export function safeReturnTo(value: string | null | undefined): string {
	if (!value) return "/";
	if (!value.startsWith("/")) return "/";
	if (value.startsWith("//")) return "/";
	return value;
}
