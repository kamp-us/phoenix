/**
 * The shell-key manifest — the one declared source of the flag keys the worker injects into
 * `window.__BOOT__` and the client consumes, so the two key sets can never drift. See ADR 0179.
 *
 * Plain strings, no alchemy/React import, so it is safe in both bundles. The drift guard
 * ({@link assertShellBootKeysSingleSourced}) is deliberately an in-app unit-tested check rather
 * than a CI guard (#2928) — a CI guard would live outside the bundle it guards.
 */
import type {User} from "../../worker/features/fate/views.ts";
import {MECMUA_FEED, MECMUA_PUBLIC_READ} from "./keys.ts";

/**
 * Only the flags whose wrong value moves geometry at first paint (ADR 0179 §1); below-fold flags
 * stay on the client fetch path. The Subnav-zone seam graduated and was retired (ADR 0136), so no
 * flag shapes those zones any more.
 */
export const SHELL_FLAG_KEYS = [MECMUA_PUBLIC_READ, MECMUA_FEED] as const;

export type ShellFlagKey = (typeof SHELL_FLAG_KEYS)[number];

/**
 * The edge-resolved current user carried in `window.__BOOT__.user` — see ADR 0185. Single-sourced
 * here so the injected and consumed objects can't drift; `null` covers both a signed-out viewer
 * and the absent-`__BOOT__` fallback.
 */
export type BootUser = Omit<User, "__typename">;

/**
 * The boolean-member key set both sides derive from, enforced by
 * {@link assertShellBootKeysSingleSourced}. The signed-in state is NOT a member key — it rides the
 * typed {@link BootUser} `user` field (ADR 0185).
 */
export const BOOT_MEMBER_KEYS = [...SHELL_FLAG_KEYS] as const;

export type BootMemberKey = (typeof BOOT_MEMBER_KEYS)[number];

/** A drift between a bundle's `__BOOT__` key set and the manifest — the fail-closed signal. */
export class ShellKeyDriftError extends Error {
	readonly side: string;
	readonly missing: readonly string[];
	readonly extra: readonly string[];

	constructor(side: string, missing: readonly string[], extra: readonly string[]) {
		super(
			`shell-key manifest drift on the ${side} side: ` +
				`missing [${missing.join(", ")}] extra [${extra.join(", ")}] ` +
				`— the injected and consumed __BOOT__ key sets MUST both derive from BOOT_MEMBER_KEYS (ADR 0179 §3).`,
		);
		this.name = "ShellKeyDriftError";
		this.side = side;
		this.missing = missing;
		this.extra = extra;
	}
}

function assertKeySetIsManifest(side: string, candidate: readonly string[]): void {
	const canonical = new Set<string>(BOOT_MEMBER_KEYS);
	const seen = new Set<string>(candidate);
	const missing = [...canonical].filter((k) => !seen.has(k));
	const extra = [...seen].filter((k) => !canonical.has(k));
	if (missing.length > 0 || extra.length > 0) {
		throw new ShellKeyDriftError(side, missing, extra);
	}
}

/**
 * The fail-closed single-source drift guard (ADR 0179 §3): each side passes the keys it actually
 * injects / reads, so a shell key added on one side without the other throws before it can
 * staleness-break the shell.
 */
export function assertShellBootKeysSingleSourced(
	injected: readonly string[],
	consumed: readonly string[],
): void {
	assertKeySetIsManifest("worker __BOOT__ injection", injected);
	assertKeySetIsManifest("client __BOOT__ consumption", consumed);
}
