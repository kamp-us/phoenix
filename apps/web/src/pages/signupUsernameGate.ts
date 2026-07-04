/**
 * The signup→setUsername resolution gate (#1888).
 *
 * A chosen username can't ride `signUp.email` (`username` is better-auth
 * `input: false`), so the handle is set by a *separate* post-signup `setUsername`
 * mutation (`AuthPage`). The moment `signUp.email` establishes the session,
 * `Layout`'s redirect effect navigates the user off `/auth` — which unmounts
 * `AuthPage` and discards its error state. If `setUsername` fails in that window,
 * the chosen handle is silently dropped: the account lands with `username === null`,
 * `UsernameBootstrap` mounts with the email-derived prefill, and one reflexive
 * "devam et" locks in a permanent, wrong, email-derived handle — the reported bug.
 *
 * This module is the shared latch that closes that race: while a chosen-username
 * signup is still resolving (or has failed and is awaiting a retry), the gate is
 * "pending" and `Layout`'s redirect holds, keeping the user on `AuthPage` where the
 * failure is visible and retryable. The gate clears only when the handle actually
 * lands (redirect proceeds) or the user deliberately abandons the chosen handle.
 *
 * A module-level `useSyncExternalStore` source (not a context provider) so the
 * single writer (`AuthPage`) and the single reader (`Layout`) share it without
 * threading a provider through the tree — both live in the same SPA render root.
 */
import {useSyncExternalStore} from "react";

let pending = false;
const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) l();
}

/** Latch the gate: a chosen-username signup is resolving — hold the redirect. */
export function beginUsernameResolution(): void {
	if (pending) return;
	pending = true;
	emit();
}

/**
 * Release the gate: the handle landed, or the user abandoned the chosen handle.
 * Idempotent — safe to call from a `finally`/cleanup path.
 */
export function endUsernameResolution(): void {
	if (!pending) return;
	pending = false;
	emit();
}

function subscribe(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
}

function getSnapshot(): boolean {
	return pending;
}

/** `true` while a chosen-username signup is still resolving — the redirect holds. */
export function useUsernameResolutionPending(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
