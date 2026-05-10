import {useCallback} from "react";
import {useLocation} from "react-router";
import type {PayloadError} from "relay-runtime";
import {useToast} from "../components/ui/Toast";
import {isSessionExpired, sessionExpiredToast} from "./mutationErrors";

/**
 * Hook returning a callback that consumes a Relay mutation result and, if
 * it carries an `UNAUTHORIZED` GraphQL error, shows the session-expired
 * toast carrying a `/auth?returnTo=<current>` link.
 *
 * Returns `true` when the error was handled (so the caller can short-circuit
 * its own error-rendering path), `false` otherwise.
 *
 * Wire it on every write mutation's `onCompleted` AND `onError` callbacks.
 */
export function useSessionExpiredToast(): {
	/**
	 * Returns `true` when the error was handled (so the caller can short-circuit
	 * its own error-rendering path), `false` otherwise. Cast to `void` at call
	 * sites where Relay's onCompleted/onError typings don't accept a return.
	 */
	handleError: (
		errors: ReadonlyArray<PayloadError> | null | undefined,
		thrown?: unknown,
	) => boolean;
} {
	const {show} = useToast();
	const location = useLocation();
	const handleError = useCallback(
		(errors: ReadonlyArray<PayloadError> | null | undefined, thrown?: unknown) => {
			if (!isSessionExpired(errors, thrown)) return false;
			const path = `${location.pathname}${location.search}`;
			show(sessionExpiredToast(path));
			return true;
		},
		[show, location.pathname, location.search],
	);
	return {handleError};
}
