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
	type BootMemberKey,
	SHELL_SIGNED_IN_KEY,
	type ShellFlagKey,
} from "../../../src/flags/shell-keys.ts";

/**
 * The `window.__BOOT__` payload: every `__BOOT__`-member key → boolean. The keys are
 * exactly {@link BOOT_MEMBER_KEYS} (the shell flags + `signedIn`), single-sourced from
 * the manifest so the injected shape can't drift from what the client reads (#2928).
 */
export type BootPayload = Record<BootMemberKey, boolean>;

/**
 * Assemble the payload from the per-request session presence + the resolved shell-flag
 * values. `signedIn` is the presence bit that drives shell geometry directly (ADR 0179
 * §1), not a flag — so it is set here, not evaluated through the flag service.
 */
export const buildBootPayload = (
	signedIn: boolean,
	shellFlags: Record<ShellFlagKey, boolean>,
): BootPayload => ({...shellFlags, [SHELL_SIGNED_IN_KEY]: signedIn});

/**
 * The inline `<script>` that seeds `window.__BOOT__` before the app module runs. `<`
 * is escaped to `<` so a value can never close the tag / open a comment — XSS-safe
 * by construction even though today's values are all booleans (defense at the boundary,
 * not a bet on the payload staying boolean).
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
	assertShellBootKeysSingleSourced(Object.keys(payload), [...BOOT_MEMBER_KEYS]);
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
