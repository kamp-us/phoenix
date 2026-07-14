/**
 * The worker-first shell route (ADR 0179, epic #2926, child #2929): the catch-all
 * (`* /*`) that serves the SPA shell through the worker and injects `window.__BOOT__`
 * at the edge, dark behind `PHOENIX_EDGE_SHELL_BOOT`.
 *
 * With the CF spa-shell recipe (`["/*", "!/assets/*"]`, `worker-routes.ts`) every
 * non-asset request now reaches the worker; the specific worker routes (`/fate`,
 * `/api/*`, `/rss.xml`) win by find-my-way precedence and this catch-all handles the
 * rest. It is a transparent proxy to the `ASSETS` binding — byte-identical to the
 * edge-direct shell (ADR 0168 amended) — that transforms ONLY an HTML `GET` when the
 * flag is on.
 *
 * Gate-first (the #2984 fix): the `PHOENIX_EDGE_SHELL_BOOT` gate is evaluated under an
 * anonymous baseline BEFORE the session is touched, so the dark (flag-off) path returns the
 * untransformed asset with ZERO session validation and zero D1 — as inert as the unconditional
 * worker-first routing allows. Only when the flag is ON does the payload get resolved per
 * request, non-cached, full (founder ruling #2833): the session is validated and the shell
 * flags are evaluated under the userId targeting context through {@link resolveRequestFlagsContext}
 * — the EXACT override-authz seam `/api/flags/evaluate` uses (the #2741 third arg), so an
 * authorized admin's override yields identical values here and from the API (ADR 0179 AC2).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {PHOENIX_EDGE_SHELL_BOOT} from "../../../src/flags/keys.ts";
import {SHELL_FLAG_KEYS, type ShellFlagKey} from "../../../src/flags/shell-keys.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Flags} from "./Flags.ts";
import {
	anonymousFlagsContext,
	FlagsContext,
	type FlagsContextValue,
	makeRequestFlagsContext,
} from "./FlagsContext.ts";
import {resolveRequestFlagsContext} from "./request-flags-context.ts";
import {buildBootPayload, injectBootScript} from "./shell-boot.ts";

/** A rejection from the `ASSETS` binding fetch — an infra defect (the never-hang fallback is #2931). */
class ShellAssetFetchError extends Schema.TaggedErrorClass<ShellAssetFetchError>()(
	"flagship/ShellAssetFetchError",
	{cause: Schema.Defect()},
) {}

// The worker runs under `@cloudflare/workers-types`, so its ambient `Response` (from `ASSETS`
// / `HTMLRewriter`) differs *by declaration* from the DOM-lib `Response` effect's
// `HttpServerResponse.fromWeb` references — the same object at runtime. `toWebResponse` bridges
// that one seam: an `unknown` param + a single narrowing cast (no `as unknown as` laundering).
const toWebResponse = (response: unknown): HttpServerResponse.HttpServerResponse =>
	HttpServerResponse.fromWeb(response as Parameters<typeof HttpServerResponse.fromWeb>[0]);

/**
 * Resolve the shell flag values under an already-resolved per-request context. Exported so
 * the parity test can read the `__BOOT__` shell flags through the exact seam the handler uses
 * (mirroring `/api/flags/evaluate`'s per-key read over the SAME context, ADR 0179 AC2).
 */
export const readShellFlags = (context: FlagsContextValue) =>
	Effect.gen(function* () {
		const flags = yield* Flags;
		const entries = yield* Effect.forEach(SHELL_FLAG_KEYS, (key) =>
			flags.getBoolean(key, false).pipe(Effect.map((value) => [key, value] as const)),
		).pipe(Effect.provideService(FlagsContext, context));
		return Object.fromEntries(entries) as Record<ShellFlagKey, boolean>;
	});

export const handleShellBoot = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const env = yield* Cloudflare.WorkerEnvironment;
	const flags = yield* Flags;
	// The `ASSETS` Fetcher binding, typed off the untyped worker env (`Record<string, any>`) so
	// no cast is needed; `fetch` takes the request as-is and returns the workers-types `Response`.
	const assets: {fetch(request: typeof raw): Promise<Response>} = env.ASSETS;
	// The untransformed shell/asset — the same bytes the edge-direct binding served before this
	// route existed. Worker-first routing is UNCONDITIONAL (not flag-gated), so this fetch runs in
	// both flag states; a rejection is an infra defect (`orDie`), and #2931 replaces this with the
	// never-hang timeout + untransformed-asset fallback.
	const assetResponse = yield* Effect.tryPromise({
		try: () => assets.fetch(raw),
		catch: (cause) => new ShellAssetFetchError({cause}),
	}).pipe(Effect.orDie);

	// Only an HTML GET is a shell navigation to inject into; a non-GET or a non-HTML asset
	// (favicon, manifest) passes through byte-identical — no gate/session/flag work at all.
	const isHtml = (assetResponse.headers.get("content-type") ?? "").includes("text/html");
	if (raw.method !== "GET" || !isHtml) return toWebResponse(assetResponse);

	// GATE FIRST (#2984): evaluate `PHOENIX_EDGE_SHELL_BOOT` under an anonymous baseline context
	// (environment only — no session, no D1) BEFORE any session validation. The gate is a global
	// dark-ship flag, so the anonymous read is authoritative; a flag-off request returns here with
	// zero added D1 and zero override-authz work — the dark path is a true no-op.
	const gateContext = yield* makeRequestFlagsContext(anonymousFlagsContext, null);
	const on = yield* flags
		.getBoolean(PHOENIX_EDGE_SHELL_BOOT, false)
		.pipe(Effect.provideService(FlagsContext, gateContext));
	if (!on) return toWebResponse(assetResponse);

	// Flag ON: NOW validate the session and resolve the full context through the SAME override-authz
	// seam `/api/flags/evaluate` uses (the #2741 third arg), then read the shell flags under it.
	const pasaport = yield* Pasaport;
	const session = yield* pasaport.validateSession(raw.headers);
	const context = yield* resolveRequestFlagsContext(session, raw.headers.get("cookie"));
	const shellFlags = yield* readShellFlags(context);

	const payload = buildBootPayload(session !== null, shellFlags);
	return toWebResponse(injectBootScript(assetResponse, payload));
});

export const shellBootRoute = HttpRouter.add("*", "/*", handleShellBoot);
