/**
 * Classifies a Cloudflare deploy error as a TRANSIENT (eventually-consistent) hiccup
 * worth retrying vs a genuine deploy failure that must fail fast. A pure leaf (no
 * `alchemy.run.ts` / CF-creds dependency) so the classification is unit-testable;
 * `_integration.ts` wraps it in the bounded `deployTransientRetry`.
 */

// The eventually-consistent CF signatures the stage deploy can transiently draw under
// cross-PR load on the shared account — registry lag right after `putScript`. Grounded in
// the `@distilled.cloud/cloudflare` error decode (`src/services/workers.ts`): `WorkerNotFound`
// = code 10007, `InternalServerError` = 15000, `UnknownCloudflareError` = 10013 — the same tags
// alchemy-effect's own create path retries piecewise (`Cloudflare/Workers/Worker.ts`), here
// applied to the deploy as a whole. ONLY these transient tags retry; a real deploy error (bad
// config, auth, a 10068 invalid-script) carries a different tag and still fails fast.
//
// `BadRequest` (HTTP 400, decoded by `@distilled.cloud/core/errors` via `HTTP_STATUS_MAP[400]`)
// joins them as a DEPLOY-TIME transient: `putScript` (the deploy op) declares `status: 400`, and
// the dep classifies it non-retryable by default (correct for a genuinely malformed script — it
// is absent from `RETRYABLE_HTTP_STATUSES`). But a freshly-created DEDICATED stage draws a 400 on
// deploy while account-level state (DO migration registry / route binding) is still propagating —
// the same eventually-consistent surface as the tags above, a different HTTP code. The empirical
// proof it's transient: the SAME commit re-runs green (`search-error-vs-empty` red main with
// `{_tag:'BadRequest'}`; #1146 added 2 more dedicated stages, widening the surface — #1153). The
// bounded `deployTransientRetry` preserves fail-fast: a real malformed script's 400 exhausts the cap.
const DEPLOY_TRANSIENT_TAGS = new Set([
	"WorkerNotFound",
	"InternalServerError",
	"UnknownCloudflareError",
	"BadRequest",
]);

// One more eventually-consistent signature, decoded NOT to a code-specific tag but to the
// bare HTTP-404 fallback `NotFound` (`@distilled.cloud/core/errors`, via `HTTP_STATUS_MAP[404]`):
// "This Worker has no versions, which means this Worker has no content or versioned settings."
// — the deploy reads the freshly-`putScript`ed worker before its version propagates through the
// registry (an original #1010 flake signature). Matched on the MESSAGE, not the bare `NotFound`
// _tag: a blanket 404 retry would mask a genuinely-missing resource, which must still fail fast.
// This precise substring is the version-propagation race alone.
const NO_VERSIONS_MESSAGE = "no versions";

export const isTransientDeployError = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
	const {_tag: tag, message} = error as {_tag: unknown; message?: unknown};
	if (typeof tag === "string" && DEPLOY_TRANSIENT_TAGS.has(tag)) return true;
	return tag === "NotFound" && typeof message === "string" && message.includes(NO_VERSIONS_MESSAGE);
};
