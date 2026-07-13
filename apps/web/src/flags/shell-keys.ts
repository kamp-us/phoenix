/**
 * The shell-key manifest — the single declared source of the shell-critical flag keys
 * that the worker resolves at the edge and injects into `window.__BOOT__`, consumed
 * synchronously by the client (ADR 0179, the `__BOOT__` contract). The same
 * single-source idiom as the fanned-mutations classifier (ADR 0155): ONE declared list
 * both bundles import, so the injected key set and the consumed key set can never drift.
 *
 * A plain-string module (no alchemy/React import) so it is safe in the worker bundle AND
 * the SPA bundle, mirroring the sibling {@link file://./keys.ts} and `src/lib/fateWireCodes.ts`.
 * The key *strings* are single-homed in `keys.ts`; this manifest names the subset that is
 * shell-critical, so it can never name a string the flag registry doesn't declare.
 *
 * The fail-closed drift guard is {@link assertShellBootKeysSingleSourced}. It is a pure,
 * in-app unit-tested check that lives in the same bundle as the manifest — deliberately
 * NOT a `pipeline-cli` CI guard (#2928): a CI guard would touch `packages/pipeline-cli/**`
 * and flip this slice §CP-blocking-for-merge. If a CI-level guard is wanted later it is its
 * own §CP child.
 *
 * Inert until the edge-render children consume it (#2929 worker injection, #2932 unified
 * `useFlag`): this module introduces no runtime behavior on its own.
 */
import {MECMUA_FEED, MECMUA_PUBLIC_READ, PHOENIX_NAV_IA} from "./keys.ts";

/**
 * The shell-critical flag keys — the `__BOOT__`-member flags whose wrong value moves
 * geometry at first paint (ADR 0179 §1, the geometry law). Exactly the three nav-shaping
 * flags and nothing else; below-fold flags stay on the client fetch path.
 */
export const SHELL_FLAG_KEYS = [PHOENIX_NAV_IA, MECMUA_PUBLIC_READ, MECMUA_FEED] as const;

export type ShellFlagKey = (typeof SHELL_FLAG_KEYS)[number];

/**
 * The session-presence bit. Part of the `__BOOT__` shape but NOT a flag key — it drives
 * shell geometry directly (signed-in ⇒ reserved chip slots, ADR 0179 §1) while `useSession`
 * settles, rather than resolving through the flag evaluator.
 */
export const SHELL_SIGNED_IN_KEY = "signedIn" as const;

/**
 * The full `__BOOT__` member key set — the shell flag keys plus the presence bit. This is
 * the shape the worker injects and the client reads; both sides derive from this one array,
 * enforced by {@link assertShellBootKeysSingleSourced}.
 */
export const BOOT_MEMBER_KEYS = [...SHELL_FLAG_KEYS, SHELL_SIGNED_IN_KEY] as const;

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

/**
 * Fail-closed: assert a candidate `__BOOT__` key set is EXACTLY the manifest's — any missing
 * or extra key throws {@link ShellKeyDriftError}. `side` names the seam for the error message.
 */
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
 * The single-source drift guard (ADR 0179 §3, fanned-mutations idiom of ADR 0155): assert
 * BOTH the worker-injected `__BOOT__` key set and the client-consumed key set derive from the
 * one manifest. A divergence on either seam throws — so a shell key added/removed on one side
 * without the other is caught, fail-closed, before it can staleness-break the shell.
 *
 * Both sides pass the keys they actually inject / read; each is checked against
 * {@link BOOT_MEMBER_KEYS}. Called at each seam by the consuming children AND unit-tested here,
 * so the invariant holds at authoring time and at runtime.
 */
export function assertShellBootKeysSingleSourced(
	injected: readonly string[],
	consumed: readonly string[],
): void {
	assertKeySetIsManifest("worker __BOOT__ injection", injected);
	assertKeySetIsManifest("client __BOOT__ consumption", consumed);
}
