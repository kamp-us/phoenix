/**
 * The edge-render pure core — building the `window.__BOOT__` payload and injecting it into
 * the SPA shell (ADR 0179). Kept separate from the Effect route so it is unit-testable
 * without a worker runtime; the one workerd dependency is {@link injectBootScript}'s
 * `HTMLRewriter`.
 */
import {
	assertShellBootKeysSingleSourced,
	BOOT_MEMBER_KEYS,
	type BootUser,
	type ShellFlagKey,
} from "../../../src/flags/shell-keys.ts";

/**
 * The `window.__BOOT__` payload. `user` is carried for synchronous first-paint identity
 * (ADR 0185, amending 0179). The boolean member keys are single-sourced from the manifest
 * so the injected shape can't drift from what the client reads (#2928).
 */
export type BootPayload = Record<ShellFlagKey, boolean> & {user: BootUser | null};

/**
 * `user` comes through the SAME session→user seam the `/fate` `me` view uses, never through
 * the flag service.
 */
export const buildBootPayload = (
	user: BootUser | null,
	shellFlags: Record<ShellFlagKey, boolean>,
): BootPayload => ({...shellFlags, user});

/**
 * `<` is escaped to `<` so a value can never close the tag or open a comment. Load-bearing
 * now that the payload carries user-controlled strings (name/handle/email), not only booleans.
 */
export const bootScriptTag = (payload: BootPayload): string =>
	`<script>window.__BOOT__=${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;

/**
 * Appends the `__BOOT__` script to `<head>` so it runs before the deferred app module reads
 * it. The response carries **no `Cache-Control`** (ADR 0179 / ADR 0170): the injected shell
 * is viewer-dependent, so the asset binding's directive is stripped and none is added.
 */
export const injectBootScript = (assetResponse: Response, payload: BootPayload): Response => {
	// The drift guard covers the boolean flag members only — `user` is a typed field (ADR
	// 0185), not a manifest member key.
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
