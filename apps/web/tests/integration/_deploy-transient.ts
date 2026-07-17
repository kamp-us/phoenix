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
// `TooManyRequests` (a WHOLE-tag transient, unlike the message-scoped cases below): the CF D1
// control-plane rate-limit that reds `integration` on unrelated PRs when two PRs' CI overlap on
// the one shared account (#2638; observed on PR #2625/#2635). Grounded in the
// `@distilled.cloud/cloudflare` decode (`src/client/api.ts`): the in-band `code: 971` ("Please
// wait and consider throttling your request speed"), a bare HTTP-429, and the global rate-limit
// message ALL decode to `_tag: "TooManyRequests"` (`GLOBAL_ERROR_CODE_MAP[971]` and the
// `status === 429` branch). It joins the set UNSCOPED — no message match — because core marks the
// class `Category.withRetryable({throttling: true})`: a rate limit is transient by construction, so
// the whole tag rides the bounded backoff (a persistent limit still exhausts the cap and fails fast).
const DEPLOY_TRANSIENT_TAGS = new Set([
	"WorkerNotFound",
	"InternalServerError",
	"UnknownCloudflareError",
	"BadRequest",
	"TooManyRequests",
]);

// One more eventually-consistent signature, decoded NOT to a code-specific tag but to the
// bare HTTP-404 fallback `NotFound` (`@distilled.cloud/core/errors`, via `HTTP_STATUS_MAP[404]`):
// "This Worker has no versions, which means this Worker has no content or versioned settings."
// — the deploy reads the freshly-`putScript`ed worker before its version propagates through the
// registry (an original #1010 flake signature). Matched on the MESSAGE, not the bare `NotFound`
// _tag: a blanket 404 retry would mask a genuinely-missing resource, which must still fail fast.
// This precise substring is the version-propagation race alone.
const NO_VERSIONS_MESSAGE = "no versions";

// The preview-deploy edge-session's eventually-consistent signature: the `AuthError` _tag whose
// message carries the "Edge-preview secret read failed:" prefix. That prefix is the single wrapper
// alchemy stamps on EVERY `EdgeSessionError` at `Cloudflare/StateStore/State.ts`'s
// `catchTag("EdgeSessionError")` (grounded: alchemy@2.0.0-beta.59 `State.ts:597`), so it fronts BOTH
// preview-deploy infra transients we've observed eject an innocent merge_group PR:
//   - "…: Secret probe returned <code>" — a non-2xx secret probe (`State.ts:792`; 400-HTML / 5xx).
//     ADR 0061 documents this verbatim as the flake that ejected approved PR #2148 (#2156).
//   - "…: Failed to create edge preview session" — the edge-session bootstrap itself failing under
//     the shared account's cross-PR load (`EdgeSession.ts:155`; observed on merge_group run
//     29560455218, #3409). The prior match pinned only the probe wording, so this sibling escaped
//     unretried and hard-failed the batch.
// Matched on the wrapper PREFIX, NOT the bare `AuthError` _tag: a genuine auth failure (bad/expired
// token, wrong account) is a DIFFERENT AuthError without this prefix and must still fail fast — the
// bounded `deployTransientRetry` cap also fails fast on a persistent edge-session error.
const EDGE_PREVIEW_MESSAGE = "Edge-preview secret read failed";

export const isTransientDeployError = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
	const {_tag: tag, message} = error as {_tag: unknown; message?: unknown};
	if (typeof tag === "string" && DEPLOY_TRANSIENT_TAGS.has(tag)) return true;
	if (tag === "NotFound" && typeof message === "string" && message.includes(NO_VERSIONS_MESSAGE))
		return true;
	return (
		tag === "AuthError" && typeof message === "string" && message.includes(EDGE_PREVIEW_MESSAGE)
	);
};
