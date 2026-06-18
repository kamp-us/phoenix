/**
 * Flag HTTP routes (epic #488):
 *
 * - `GET  /api/flags/probe`    — the #508 dark-ship demonstrator: reads one
 *   boolean flag through `Flags` and branches on it.
 * - `POST /api/flags/evaluate` — the #510 SPA delivery seam: the browser names
 *   the flags it needs (`{key, default}` pairs) and the Worker returns the
 *   **server-evaluated** value for each. Evaluation stays in-isolate via `Flags`;
 *   the targeting context (user identity) is derived here from the session and
 *   never travels from or to the browser — the client sees only resolved booleans.
 *
 * Both build the per-request {@link FlagsContext} via `makeRequestFlagsContext`
 * (the session's user id for stable bucketing, plus the deploy `environment`
 * sourced from the stage — #512) and provide it inline — supplied alongside
 * `Auth` (ADR 0029), not at isolate scope. With no session they fall back to the
 * anonymous identity. Reads never throw: an undeclared flag or a Flagship outage
 * collapses to the caller's supplied default (the `Flags` safe-default contract).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {type FlagEvaluateResult, parseFlagEvaluateRequest} from "./evaluate-contract.ts";
import {Flags} from "./Flags.ts";
import {
	anonymousFlagsContext,
	FlagsContext,
	type FlagsContextValue,
	makeRequestFlagsContext,
} from "./FlagsContext.ts";

/** The dark-ship flag this probe gates on — undeclared, so it reads its default. */
const PROBE_FLAG = "phoenix-flags-probe";

/** A typed (string) variation the probe reads to demonstrate the non-boolean reads (#509). */
const PROBE_VARIANT_FLAG = "phoenix-flags-probe-variant";

/** Derive the evaluation identity from the session — server-side only, never client-supplied. */
const contextFromSession = (session: {user: {id: string}} | null): FlagsContextValue =>
	session ? {userId: session.user.id} : anonymousFlagsContext;

export const handleFlagsProbe = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const pasaport = yield* Pasaport;
	const flags = yield* Flags;

	const session = yield* pasaport.validateSession(raw.headers);
	// The environment attribute is sourced from the deploy stage (`ENVIRONMENT`,
	// ADR 0057), not hand-passed — so an environment-targeting rule resolves per
	// stage with no change here (#512).
	const context = yield* makeRequestFlagsContext(contextFromSession(session));

	// The dark-ship read: the safe default is the off path, and the call provides
	// the per-request identity context for bucketing.
	const enabled = yield* flags
		.getBoolean(PROBE_FLAG, false)
		.pipe(Effect.provideService(FlagsContext, context));

	// A typed (non-boolean) read through the same service — the safe default is the
	// fallback variant; a server with the flag declared would return its value (#509).
	const variant = yield* flags
		.getString(PROBE_VARIANT_FLAG, "control")
		.pipe(Effect.provideService(FlagsContext, context));

	// Branch on the flag — the whole point of the primitive.
	return HttpServerResponse.jsonUnsafe({
		flag: PROBE_FLAG,
		enabled,
		branch: enabled ? "on" : "off",
		variant,
	});
});

export const flagsProbeRoute = HttpRouter.add("GET", "/api/flags/probe", handleFlagsProbe);

export const handleFlagsEvaluate = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const pasaport = yield* Pasaport;
	const flags = yield* Flags;

	const body = yield* Effect.promise(() => raw.json().catch(() => null));
	// A malformed body yields zero requested keys, so the response is `{flags:{}}`
	// and the client stays at its defaults — the safe-default contract end to end.
	const keys = parseFlagEvaluateRequest(body);

	const session = yield* pasaport.validateSession(raw.headers);
	// Same per-request context as the probe: session-derived identity plus the
	// stage `environment` (#512), so every key is evaluated under the full
	// targeting context — identity stays server-side, never from the body.
	const context = yield* makeRequestFlagsContext(contextFromSession(session));

	// Evaluate every requested flag server-side under the session-derived context.
	// Each `getBoolean` honors its own supplied default and never throws.
	const entries = yield* Effect.forEach(keys, ({key, default: defaultValue}) =>
		flags.getBoolean(key, defaultValue).pipe(
			Effect.provideService(FlagsContext, context),
			Effect.map((value) => [key, value] as const),
		),
	);

	const result: FlagEvaluateResult = {flags: Object.fromEntries(entries)};
	return HttpServerResponse.jsonUnsafe(result);
});

export const flagsEvaluateRoute = HttpRouter.add(
	"POST",
	"/api/flags/evaluate",
	handleFlagsEvaluate,
);
