/**
 * The worker-first shell route (ADR 0179): the catch-all that proxies the SPA shell
 * from the `ASSETS` binding and injects `window.__BOOT__` at the edge. The specific
 * worker routes win by find-my-way precedence; this handles the rest.
 *
 * `__BOOT__` must be absent-or-complete, never partial — a non-HTML asset or a
 * non-`GET` passes through untouched, and {@link withNeverHangFallback} degrades a
 * slow or failing resolve to the untransformed asset.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {type BootUser, SHELL_FLAG_KEYS, type ShellFlagKey} from "../../../src/flags/shell-keys.ts";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {resolveMeUser} from "../pasaport/trusted-user.ts";
import type {User} from "../pasaport/views.ts";
import {Flags} from "./Flags.ts";
import {FlagsContext, type FlagsContextValue} from "./FlagsContext.ts";
import {resolveRequestFlagsContext} from "./request-flags-context.ts";
import {buildBootPayload, injectBootScript} from "./shell-boot.ts";

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
 * An explicit field list, not an `Omit` spread, so a wire-shape change surfaces here
 * as a compile error (ADR 0185).
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
 * Exported so the parity test reads the `__BOOT__` shell flags through the exact seam
 * the handler uses (ADR 0179 AC2).
 */
export const readShellFlags = (context: FlagsContextValue) =>
	Effect.gen(function* () {
		const flags = yield* Flags;
		const entries = yield* Effect.forEach(
			SHELL_FLAG_KEYS,
			(key) => flags.getBoolean(key, false).pipe(Effect.map((value) => [key, value] as const)),
			{concurrency: 1},
		).pipe(Effect.provideService(FlagsContext, context));
		return Object.fromEntries(entries) as Record<ShellFlagKey, boolean>;
	});

/**
 * Tunable — the invariant is that a bound EXISTS, not its exact value (ADR 0179 §2).
 */
export const SHELL_BOOT_READ_TIMEOUT = Duration.seconds(1);

/**
 * The never-hang / safe-default-on-outage guard (ADR 0179 §4). Only expected failures
 * (the `E` channel) and the timeout degrade to the untransformed asset; a genuine
 * defect still propagates.
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
	const assets: {fetch(request: typeof raw): Promise<Response>} = env.ASSETS;
	// A rejection stays an infra defect (`orDie`): this response is the fallback SOURCE,
	// so if it fails there is nothing to serve. The never-hang timeout wraps the boot
	// READS (session + flags) below, not this fetch.
	const assetResponse = yield* Effect.tryPromise({
		try: () => assets.fetch(raw),
		catch: (cause) => new ShellAssetFetchError({cause}),
	}).pipe(Effect.orDie);

	const isHtml = (assetResponse.headers.get("content-type") ?? "").includes("text/html");
	if (raw.method !== "GET" || !isHtml) return toWebResponse(assetResponse);

	// Resolves the context through the SAME override-authz seam `/api/flags/evaluate`
	// uses, so an authorized admin's override yields identical values here and from the
	// API (ADR 0179 AC2).
	const resolveAndInject = Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const session = yield* pasaport.validateSession(raw.headers);
		const context = yield* resolveRequestFlagsContext(session, raw.headers.get("cookie"));
		const shellFlags = yield* readShellFlags(context);
		// The SAME session→user seam the `/fate` `me` view uses (ADR 0185), so first paint
		// reads identity synchronously off `__BOOT__.user` instead of the async `useMe`.
		const user = session ? toBootUser(yield* resolveMeUser(session.user)) : null;
		const payload = buildBootPayload(user, shellFlags);
		return injectBootScript(assetResponse, payload);
	});

	const response = yield* withNeverHangFallback(resolveAndInject, assetResponse);
	return toWebResponse(response);
});

export const shellBootRoute = HttpRouter.add("*", "/*", handleShellBoot);
