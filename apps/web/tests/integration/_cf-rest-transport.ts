/**
 * The ONE Cloudflare-REST transport every integration-test CF call goes through — proactive
 * throttle (`_cf-api-throttle.ts`, #3081) composed with reactive 429 retry (`_d1-rest-retry.ts`,
 * #2915/#3099), plus the Effect layer that carries it into `makeD1Rest` (#3548).
 *
 * **Why this module exists: the protection used to be opt-in per call site, so half the harness
 * bypassed it.** #3099 wrapped the fetch of exactly the two test files that were failing at the
 * time; every other file kept hand-rolling `Layer.merge(CredentialsFromEnv, FetchHttpClient.layer)`
 * — the BARE fetch, no retry, no throttle. In run `29665891972` that gap red `pasaport-ban.test.ts`
 * with a raw `TooManyRequests` off `@distilled.cloud/cloudflare`'s `971` mapping, while its sibling
 * `pasaport-set-role.test.ts` (added by the very PR that got ejected, and wired to the wrapped
 * fetch) passed through the same 429 storm. So the fix is not another wrapper: it is making the
 * protected transport the only one a test can reach. `integrationRestLayer` is that transport, and
 * `_cf-rest-transport.unit.test.ts` fails closed if a file re-introduces a bare one.
 *
 * **Composition order — retry AROUND throttle, deliberately inverting #3081's note.** #3081 wired
 * `throttle.run(() => retry(send))` so a logical call counts as one throttled unit. That makes the
 * concurrency cap count a call SLEEPING IN BACKOFF as "in flight": under 429 pressure four backing-off
 * calls hold all four slots and head-of-line-block every other CF call in the fork — which the longer
 * wall-clock budget (#3548) would have made far worse. A sleeping call is by definition not in flight,
 * so the slot is held per ATTEMPT instead: `retry(() => throttle.run(send))`. This also start-paces
 * the retries themselves, which #3081's order left unpaced — the attempts that most need spreading.
 *
 * **The cost of that order is paid here: throttle queueing is not retry attrition.** Re-entering the
 * throttle per attempt means a logical call sits in the harness's own queue repeatedly, which a
 * wall-clock deadline then charges to the budget it meant to spend asking Cloudflare (`_d1-rest-retry.ts`
 * has the measured arithmetic). Wiring `run`'s `onQueued` into the retry's `queued` sink is what
 * keeps the two halves of the composition from cannibalising each other; the unit test pins it.
 */

import {CredentialsFromEnv} from "@distilled.cloud/cloudflare/Credentials";
import {makeD1Rest} from "@kampus/d1-rest";
import {Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {cfApiThrottle} from "./_cf-api-throttle.ts";
import {
	cfFetchWithRateLimitRetry,
	type RateLimitRetryOptions,
	rateLimitRetryingFetch,
} from "./_d1-rest-retry.ts";

/**
 * Send one CF REST request under the shared throttle, retrying a 429 for the whole budget. The
 * throttle's own queueing is reported into the retry's `queued` sink, so the budget measures time
 * CLOUDFLARE spent rate-limiting the call rather than time the harness spent pacing it (#3548).
 */
export const cfRestSend = (
	send: () => Promise<Response>,
	options: RateLimitRetryOptions = {},
): Promise<Response> =>
	cfFetchWithRateLimitRetry((queued) => cfApiThrottle.run(send, queued), options);

export const cfRestFetch: typeof globalThis.fetch = rateLimitRetryingFetch((input, init, queued) =>
	cfApiThrottle.run(() => fetch(input, init), queued),
);

/**
 * The credentialed REST layer every integration test builds its `makeD1Rest` client from. Replaces
 * the per-file `Layer.merge(CredentialsFromEnv, FetchHttpClient.layer)` — same credentials, same
 * transport shape, but the `Fetch` reference is {@link cfRestFetch} rather than the bare one.
 */
export const integrationRestLayer = Layer.merge(
	CredentialsFromEnv,
	FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, cfRestFetch))),
);

export const makeIntegrationD1Rest = (target: {accountId: string; databaseId: string}) =>
	makeD1Rest({...target, layer: integrationRestLayer});
