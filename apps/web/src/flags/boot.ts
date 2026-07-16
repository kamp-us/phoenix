/**
 * The client half of the `window.__BOOT__` contract, read as OPTIONAL (ADR 0179 §4, #2931).
 *
 * The edge injects `window.__BOOT__` only when the shell renders through the worker with the flag
 * on AND the boot resolve succeeds within the never-hang bound. When it is ABSENT — the flag is
 * off, or a Flagship/session outage tripped the never-hang fallback to the untransformed asset —
 * these readers return `undefined` so the consumer resolves through its existing fetch path. A
 * missing payload is a first-class, non-error state, never an assumption that injection happened;
 * the unified `useFlag` (#2932) consumes this, so the optional contract lives here at its source.
 */
import type {BootMemberKey, BootUser} from "./shell-keys.ts";

/**
 * The edge-injected payload as the client sees it: every boolean member key MAY be present, plus
 * the edge-resolved current `user` (ADR 0185) — absent/`null` for a signed-out viewer or the
 * absent-`__BOOT__` fallback.
 */
export type BootPayload = Partial<Record<BootMemberKey, boolean>> & {user?: BootUser | null};

declare global {
	interface Window {
		__BOOT__?: BootPayload;
	}
}

/**
 * Read `window.__BOOT__` when the edge injected a well-formed object, else `undefined`. Optional by
 * construction: absence (outage fallback or flag off) is not an error — the caller falls back to
 * its fetch path when this returns `undefined`.
 */
export function readBoot(): BootPayload | undefined {
	if (typeof window === "undefined") return undefined;
	const boot = window.__BOOT__;
	return typeof boot === "object" && boot !== null ? boot : undefined;
}

/**
 * Read a single `__BOOT__`-member key. Returns the injected boolean when present, else `undefined`
 * — a missing payload, a missing key, or a non-boolean value all fall back rather than fabricate a
 * value.
 */
export function readBootMember(key: BootMemberKey): boolean | undefined {
	const value = readBoot()?.[key];
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Read the edge-resolved current user from `window.__BOOT__.user` (ADR 0185, amending 0179):
 * the full identity, so first-paint surfaces (the navbar cluster, the pano CTA, `useMe`'s seed)
 * render the signed-in state SYNCHRONOUSLY instead of the async `useMe` fetch. Returns `null`
 * for a signed-out viewer AND for the absent-`__BOOT__` fallback (flag off / the #2931 never-hang
 * outage) — the caller then resolves through its async path, never assuming injection happened.
 */
export function readBootUser(): BootUser | null {
	const user = readBoot()?.user;
	return typeof user === "object" && user !== null ? user : null;
}
