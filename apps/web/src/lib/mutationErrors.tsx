import type {PayloadError} from "relay-runtime";
import {authRedirectPath} from "./returnTo";

/**
 * Inspect a Relay mutation error payload (either an `Error` thrown via
 * `onError` or a `PayloadError[]` from `onCompleted`'s second arg) and decide
 * whether it represents a session-expired condition.
 *
 * `UNAUTHORIZED` is the stable wire-level code the worker resolvers attach
 * to GraphQL errors when `Auth.required` fails or when an Agent throws an
 * `UnauthorizedXxxMutationError` (see `worker/graphql/schema.ts`'s
 * mapDefinition/Post/Comment error helpers).
 */
export function isSessionExpired(
	errors: ReadonlyArray<PayloadError> | null | undefined,
	thrown?: unknown,
): boolean {
	if (errors && errors.length > 0) {
		for (const e of errors) {
			// `extensions` isn't part of Relay's `PayloadError` type but is
			// always present on the wire (GraphQL spec). Read defensively.
			const ext = (e as unknown as {extensions?: {code?: string}}).extensions;
			if (ext?.code === "UNAUTHORIZED") return true;
		}
	}
	if (thrown && typeof thrown === "object" && thrown !== null) {
		// Relay's `onError` callback hands back a plain Error built from the
		// failure response. Match on the message ("not authorized") as a
		// fallback for environments where `extensions` doesn't survive.
		const msg = String((thrown as {message?: string}).message ?? "");
		if (/not authorized/i.test(msg)) return true;
	}
	return false;
}

/**
 * Build the toast descriptor for the session-expired notice. Carries a link
 * back to `/auth?returnTo=<current>` so the user can recover without losing
 * their place.
 */
export function sessionExpiredToast(currentPath: string) {
	const href = authRedirectPath(currentPath);
	return {
		// Stable id so re-firing the toast on consecutive failures replaces
		// the row instead of stacking copies.
		id: "session-expired",
		testId: "session-expired",
		// Persist until dismissed manually — the user needs to read the link.
		durationMs: 0,
		message: (
			<span>
				oturum süresi doldu,{" "}
				<a href={href} data-testid="toast-session-expired-link">
					tekrar giriş yap
				</a>
				.
			</span>
		),
	};
}
