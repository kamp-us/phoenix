/**
 * The client half of the `window.__BOOT__` contract, read as OPTIONAL — see ADR 0179 §4. An absent
 * payload is a first-class, non-error state: every reader here returns `undefined`/`null` so the
 * consumer resolves through its own fetch path instead (#2931).
 */
import type {BootMemberKey, BootUser} from "./shell-keys.ts";

export type BootPayload = Partial<Record<BootMemberKey, boolean>> & {user?: BootUser | null};

declare global {
	interface Window {
		__BOOT__?: BootPayload;
	}
}

export function readBoot(): BootPayload | undefined {
	if (typeof window === "undefined") return undefined;
	const boot = window.__BOOT__;
	return typeof boot === "object" && boot !== null ? boot : undefined;
}

export function readBootMember(key: BootMemberKey): boolean | undefined {
	const value = readBoot()?.[key];
	return typeof value === "boolean" ? value : undefined;
}

/**
 * The edge-resolved current user — see ADR 0185. `null` covers BOTH a signed-out viewer and the
 * absent-`__BOOT__` fallback, so the caller resolves through its async path rather than assuming
 * injection happened.
 */
export function readBootUser(): BootUser | null {
	const user = readBoot()?.user;
	return typeof user === "object" && user !== null ? user : null;
}
