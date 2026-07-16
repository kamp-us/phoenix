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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {PHOENIX_EDGE_SHELL_BOOT} from "../../../src/flags/keys.ts";
import {type BootUser, SHELL_FLAG_KEYS, type ShellFlagKey} from "../../../src/flags/shell-keys.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {resolveMeUser} from "../pasaport/trusted-user.ts";
import type {User} from "../pasaport/views.ts";
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
 * Project the wire `User` down to the client `BootUser` for `__BOOT__.user` — the same fields
 * `useMe` exposes as `MeUser`, minus fate's transport-only `__typename` (ADR 0185). An explicit
 * field list (not an `Omit` spread) so a wire-shape change surfaces here as a compile error.
 */
const toBootUser = (user: User): BootUser => ({
	id: user.id,
	email: user.email,
	name: user.name,
	image: user.image,
	username: user.username,
	tier: user.tier,
	isModerator: user.isModerator,
	emailFailing: user.emailFailing,
});

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

/**
 * The never-hang ceiling on the per-request boot resolve — session validation (3 serial D1
 * queries when signed in) + shell-flag evaluation (ADR 0179 §2). A healthy resolve is well
 * under this; the cap bounds a slow or dead Flagship/D1 so the edge degrades rather than hangs.
 * Tunable — the invariant is that a bound EXISTS, not its exact value.
 */
export const SHELL_BOOT_READ_TIMEOUT = Duration.seconds(1);

/**
 * The never-hang / safe-default-on-outage guard (ADR 0179 §4): bound the boot resolve with
 * {@link SHELL_BOOT_READ_TIMEOUT} and, on timeout OR any Flagship/D1 failure, fall back to the
 * untransformed asset — byte-identical to the flag-off / edge-direct shell, with no partial
 * `__BOOT__`. Only expected failures (the `E` channel) + the timeout degrade; a genuine defect
 * still propagates. Exported so the never-hang invariant is unit-testable (TestClock) without a
 * deployed worker.
 */
export const withNeverHangFallback = <A, E, R>(
	resolve: Effect.Effect<A, E, R>,
	untransformed: A,
): Effect.Effect<A, never, R> =>
	resolve.pipe(
		Effect.timeout(SHELL_BOOT_READ_TIMEOUT),
		Effect.catch(() => Effect.succeed(untransformed)),
	);

export const handleShellBoot = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const env = yield* Cloudflare.WorkerEnvironment;
	const flags = yield* Flags;
	// The `ASSETS` Fetcher binding, typed off the untyped worker env (`Record<string, any>`) so
	// no cast is needed; `fetch` takes the request as-is and returns the workers-types `Response`.
	const assets: {fetch(request: typeof raw): Promise<Response>} = env.ASSETS;
	// The untransformed shell/asset — the same bytes the edge-direct binding served before this
	// route existed, and the response the never-hang fallback degrades to (#2931). Worker-first
	// routing is UNCONDITIONAL (not flag-gated), so this fetch runs in both flag states; a rejection
	// stays an infra defect (`orDie`) — it is the fallback SOURCE, so if it fails there is nothing to
	// serve. The never-hang timeout wraps the boot READS (session + flags) below, not this fetch.
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
	// seam `/api/flags/evaluate` uses (the #2741 third arg), read the shell flags under it, and inject
	// the payload. The whole resolve is wrapped in the never-hang guard: on a slow/dead Flagship or
	// D1 (timeout) or any resolve failure it degrades to the untransformed asset — never a hung or
	// 500-ing shell (ADR 0179 §4).
	const resolveAndInject = Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const session = yield* pasaport.validateSession(raw.headers);
		const context = yield* resolveRequestFlagsContext(session, raw.headers.get("cookie"));
		const shellFlags = yield* readShellFlags(context);
		// Edge-resolve the current user through the SAME session→user seam the `/fate` `me` view
		// uses (ADR 0185), so first-paint surfaces read identity synchronously off `__BOOT__.user`
		// instead of the async `useMe`; `null` when signed out. Projected off the wire `User` (drop
		// fate's `__typename`) to the client `BootUser` shape. These extra D1 reads sit inside the
		// never-hang guard below, so a slow/dead resolve degrades to the untransformed asset (#2931).
		const user = session ? toBootUser(yield* resolveMeUser(session.user)) : null;
		const payload = buildBootPayload(user, shellFlags);
		return injectBootScript(assetResponse, payload);
	});

	const response = yield* withNeverHangFallback(resolveAndInject, assetResponse);
	return toWebResponse(response);
});

export const shellBootRoute = HttpRouter.add("*", "/*", handleShellBoot);
