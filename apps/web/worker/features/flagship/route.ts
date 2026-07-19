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
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {type FlagEvaluateResult, parseFlagEvaluateRequest} from "./evaluate-contract.ts";
import {Flags} from "./Flags.ts";
import {FlagsContext, makeRequestFlagsContext} from "./FlagsContext.ts";
import {contextFromSession, resolveRequestFlagsContext} from "./request-flags-context.ts";

/** A malformed request body — mapped then recovered to the empty-keys default below. */
class FlagEvaluateBodyError extends Schema.TaggedErrorClass<FlagEvaluateBodyError>()(
	"flagship/FlagEvaluateBodyError",
	{cause: Schema.Defect()},
) {}

/** The dark-ship flag this probe gates on — undeclared, so it reads its default. */
const PROBE_FLAG = "phoenix-flags-probe";

/** A typed (string) variation the probe reads to demonstrate the non-boolean reads (#509). */
const PROBE_VARIANT_FLAG = "phoenix-flags-probe-variant";

export const handleFlagsProbe = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const pasaport = yield* Pasaport;
	const flags = yield* Flags;

	const session = yield* pasaport.validateSession(raw.headers);
	// The environment attribute is sourced from the deploy stage (`ENVIRONMENT`,
	// ADR 0057), not hand-passed — so an environment-targeting rule resolves per
	// stage with no change here (#512). The cookie carries any dev-only local
	// override (#622), applied by `makeRequestFlagsContext` ONLY under `development`.
	const context = yield* makeRequestFlagsContext(
		contextFromSession(session),
		raw.headers.get("cookie"),
	);

	// `FlagsContext` is the per-request service every read needs; provide it ONCE at
	// this handler edge (alongside the session-derived identity, ADR 0029) so the
	// reads below call `flags.get*` directly with no inline provision.
	const {enabled, variant} = yield* Effect.gen(function* () {
		// The dark-ship read: the safe default is the off path; bucketing comes from
		// the provided per-request identity context.
		const enabled = yield* flags.getBoolean(PROBE_FLAG, false);
		// A typed (non-boolean) read through the same service — the safe default is the
		// fallback variant; a server with the flag declared would return its value (#509).
		const variant = yield* flags.getString(PROBE_VARIANT_FLAG, "control");
		return {enabled, variant};
	}).pipe(Effect.provideService(FlagsContext, context));

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

	const body = yield* Effect.tryPromise({
		try: () => raw.json(),
		catch: (cause) => new FlagEvaluateBodyError({cause}),
	}).pipe(Effect.orElseSucceed(() => null));
	// A malformed body yields zero requested keys, so the response is `{flags:{}}`
	// and the client stays at its defaults — the safe-default contract end to end.
	const keys = parseFlagEvaluateRequest(body);

	const session = yield* pasaport.validateSession(raw.headers);
	// The per-request context: session-derived identity plus the stage `environment` (#512),
	// with the #2741 override-authz verdict applied so an authorized admin's cookie is honored.
	// The SAME seam the edge `__BOOT__` injection uses, so the two never diverge (ADR 0179 AC2).
	const context = yield* resolveRequestFlagsContext(session, raw.headers.get("cookie"));

	// Evaluate every requested flag server-side under the session-derived context.
	// Each `getBoolean` honors its own supplied default and never throws. The
	// per-request `FlagsContext` is provided ONCE over the whole batch (ADR 0029)
	// rather than per key, so the loop reads `flags.getBoolean` directly.
	const entries = yield* Effect.forEach(
		keys,
		({key, default: defaultValue}) =>
			flags.getBoolean(key, defaultValue).pipe(Effect.map((value) => [key, value] as const)),
		{concurrency: 1},
	).pipe(Effect.provideService(FlagsContext, context));

	const result: FlagEvaluateResult = {flags: Object.fromEntries(entries)};
	return HttpServerResponse.jsonUnsafe(result);
});

export const flagsEvaluateRoute = HttpRouter.add(
	"POST",
	"/api/flags/evaluate",
	handleFlagsEvaluate,
);
