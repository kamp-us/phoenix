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
 * flag is on. Flag off (the default dark ship) ⇒ the untransformed asset, unchanged.
 *
 * The payload is resolved per request, non-cached, full (founder ruling #2833): the
 * session is validated (3 D1 queries signed-in, zero signed-out) and the shell flags are
 * evaluated under the userId targeting context — the EXACT `validateSession` +
 * `contextFromSession` + `makeRequestFlagsContext` path `/api/flags/evaluate` uses, no
 * new machinery.
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
import {buildBootPayload, injectBootScript} from "./shell-boot.ts";

/** A rejection from the `ASSETS` binding fetch — an infra defect (the never-hang fallback is #2931). */
class ShellAssetFetchError extends Schema.TaggedErrorClass<ShellAssetFetchError>()(
	"flagship/ShellAssetFetchError",
	{cause: Schema.Defect()},
) {}

/** Derive the evaluation identity from the session — server-side only (mirrors `route.ts`). */
const contextFromSession = (session: {user: {id: string}} | null): FlagsContextValue =>
	session ? {userId: session.user.id} : anonymousFlagsContext;

// The worker runs under `@cloudflare/workers-types`, so its ambient `Response` (from `ASSETS`
// / `HTMLRewriter`) differs *by declaration* from the DOM-lib `Response` effect's
// `HttpServerResponse.fromWeb` references — the same object at runtime. `toWebResponse` bridges
// that one seam: an `unknown` param + a single narrowing cast (no `as unknown as` laundering).
const toWebResponse = (response: unknown): HttpServerResponse.HttpServerResponse =>
	HttpServerResponse.fromWeb(response as Parameters<typeof HttpServerResponse.fromWeb>[0]);

export const handleShellBoot = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const env = yield* Cloudflare.WorkerEnvironment;
	// The `ASSETS` Fetcher binding, typed off the untyped worker env (`Record<string, any>`) so
	// no cast is needed; `fetch` takes the request as-is and returns the workers-types `Response`.
	const assets: {fetch(request: typeof raw): Promise<Response>} = env.ASSETS;
	// The untransformed shell/asset — the same bytes the edge-direct binding served before this
	// route existed. A rejection is an infra defect (`orDie`); #2931 replaces this with the
	// never-hang timeout + untransformed-asset fallback.
	const assetResponse = yield* Effect.tryPromise({
		try: () => assets.fetch(raw),
		catch: (cause) => new ShellAssetFetchError({cause}),
	}).pipe(Effect.orDie);

	// Only an HTML GET is a shell navigation to inject into; a non-GET or a non-HTML asset
	// (favicon, manifest) passes through byte-identical — no session/flag work at all.
	const isHtml = (assetResponse.headers.get("content-type") ?? "").includes("text/html");
	if (raw.method !== "GET" || !isHtml) return toWebResponse(assetResponse);

	const pasaport = yield* Pasaport;
	const flags = yield* Flags;
	const session = yield* pasaport.validateSession(raw.headers);
	const context = yield* makeRequestFlagsContext(
		contextFromSession(session),
		raw.headers.get("cookie"),
	);

	// One per-request `FlagsContext` provision over the gate + shell-flag reads (ADR 0029).
	// The gate is evaluated first; when off, the shell flags are not read at all.
	const resolved = yield* Effect.gen(function* () {
		const on = yield* flags.getBoolean(PHOENIX_EDGE_SHELL_BOOT, false);
		if (!on) return {on} as const;
		const entries = yield* Effect.forEach(SHELL_FLAG_KEYS, (key) =>
			flags.getBoolean(key, false).pipe(Effect.map((value) => [key, value] as const)),
		);
		return {on, shellFlags: Object.fromEntries(entries) as Record<ShellFlagKey, boolean>} as const;
	}).pipe(Effect.provideService(FlagsContext, context));

	// Dark ship default (flag off): the untransformed asset, byte-identical to today.
	if (!resolved.on) return toWebResponse(assetResponse);

	const payload = buildBootPayload(session !== null, resolved.shellFlags);
	return toWebResponse(injectBootScript(assetResponse, payload));
});

export const shellBootRoute = HttpRouter.add("*", "/*", handleShellBoot);
