/**
 * The edge-render pure core — building the `window.__BOOT__` payload and injecting it
 * into the SPA shell (ADR 0179, the `__BOOT__` contract; epic #2926). Kept separate
 * from the Effect route (`shell-boot-route.ts`) so the payload shape, the script tag,
 * and the single-source drift guard are unit-testable without a worker runtime.
 *
 * The one workerd dependency is {@link injectBootScript}'s `HTMLRewriter` — a runtime
 * global, exercised in the integration tier, not here.
 */
import {
	assertShellBootKeysSingleSourced,
	BOOT_MEMBER_KEYS,
	type BootUser,
	type ShellFlagKey,
} from "../../../src/flags/shell-keys.ts";

/**
 * The `window.__BOOT__` payload: the shell flag keys → boolean, plus the edge-resolved current
 * `user` (`BootUser | null`) carried for synchronous first-paint identity (ADR 0185, amending
 * 0179 — supersedes #2933's presence-only `signedIn` boolean). The boolean member keys are
 * exactly {@link BOOT_MEMBER_KEYS}, single-sourced from the manifest so the injected boolean
 * shape can't drift from what the client reads (#2928); `user` is a distinct typed field,
 * single-sourced via {@link BootUser}.
 */
export type BootPayload = Record<ShellFlagKey, boolean> & {user: BootUser | null};

/**
 * Assemble the payload from the edge-resolved current user + the resolved shell-flag values.
 * `user` is the per-request identity (`null` when signed out), resolved through the SAME
 * session→user seam the `/fate` `me` view uses, not evaluated through the flag service.
 */
export const buildBootPayload = (
	user: BootUser | null,
	shellFlags: Record<ShellFlagKey, boolean>,
): BootPayload => ({...shellFlags, user});

/**
 * The inline `<script>` that seeds `window.__BOOT__` before the app module runs. `<`
 * is escaped to `<` so a value can never close the tag / open a comment — XSS-safe
 * by construction. Load-bearing now that the payload carries the `user` object's strings
 * (name/handle/email), not only booleans: a `<` in any user-controlled field can never break
 * out of the tag.
 */
export const bootScriptTag = (payload: BootPayload): string =>
	`<script>window.__BOOT__=${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;

/**
 * Stream the untransformed shell through `HTMLRewriter`, appending the `__BOOT__` script
 * to `<head>` so it runs before the deferred app module reads it. The response carries
 * **no `Cache-Control`** (ADR 0179 / founder ruling #2833): the injected shell is
 * viewer-dependent and per-request, so any cache directive the asset binding stamped is
 * stripped and none is added — viewer-dependent HTML is never cached (ADR 0170).
 *
 * The injected key set is verified against the manifest at this seam — the fail-closed
 * drift guard #2928 owns — so a shell key added here without the manifest throws.
 */
export const injectBootScript = (assetResponse: Response, payload: BootPayload): Response => {
	// The single-source drift guard covers the boolean flag members only; `user` is a distinct
	// typed field (ADR 0185), not a manifest member key, so it is excluded from the key-set check.
	const flagKeys = Object.keys(payload).filter((key) => key !== "user");
	assertShellBootKeysSingleSourced(flagKeys, [...BOOT_MEMBER_KEYS]);
	const script = bootScriptTag(payload);
	const rewritten = new HTMLRewriter()
		.on("head", {
			element(element) {
				element.append(script, {html: true});
			},
		})
		.transform(assetResponse);
	const headers = new Headers(rewritten.headers);
	headers.delete("cache-control");
	return new Response(rewritten.body, {
		status: rewritten.status,
		statusText: rewritten.statusText,
		headers,
	});
};
