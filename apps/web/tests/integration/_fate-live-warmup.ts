/**
 * Classifies a `/fate/live` warmup response as a "not ready" (keep-retrying) signal vs a
 * terminal worker answer — the readiness analogue of `_deploy-transient.ts`. A pure leaf
 * (no `fetch`/Effect dependency) so the classification is unit-testable; `_integration.ts`'s
 * `warmLiveDO` wraps it in the bounded retry.
 *
 * The warmup keeps retrying every "not ready yet" outcome until `/fate/live` serves a 200:
 *   - 503 — the worker seam's cold-start `LIVE_UNAVAILABLE` envelope (a lazily-instantiated
 *     `LiveDO` on the freshly-deployed stage's first connect; `fate-live/cold-start-retry.ts`).
 *   - a Cloudflare edge-placeholder 404 (HTML body) — a preview-stage route that hasn't
 *     propagated yet still serves the CF placeholder page even after `/api/health` is green,
 *     since the DO-backed `/fate/live` path propagates separately (#1058, repro'd on #1055).
 *
 * The ONE terminal case — distinguished so the warmup doesn't burn its whole bound retrying
 * something that will never ripen into a 200 — is a response the WORKER itself rendered as a
 * JSON client error (a real 404, a 401/403 auth response): `application/json` body + a 4xx
 * status means the request reached the worker and got a stable answer, not the edge placeholder.
 */
export const isLiveWarmupNotReady = (status: number, contentType: string): boolean => {
	const workerJsonClientError =
		status >= 400 && status < 500 && contentType.toLowerCase().includes("application/json");
	return !workerJsonClientError;
};
