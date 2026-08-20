/**
 * Flag HTTP routes (epic #488). Evaluation stays in-isolate: the targeting context is
 * derived here from the session and never travels to or from the browser, which sees only
 * resolved booleans. The per-request {@link FlagsContext} is provided at the handler edge,
 * not at isolate scope (ADR 0029). Reads never throw — an undeclared flag or a Flagship
 * outage collapses to the caller's supplied default.
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

/** Demonstrates the non-boolean reads (#509). */
const PROBE_VARIANT_FLAG = "phoenix-flags-probe-variant";

export const handleFlagsProbe = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const pasaport = yield* Pasaport;
	const flags = yield* Flags;

	const session = yield* pasaport.validateSession(raw.headers);
	// The cookie carries any dev-only local override (#622), which
	// `makeRequestFlagsContext` applies ONLY under `development`.
	const context = yield* makeRequestFlagsContext(
		contextFromSession(session),
		raw.headers.get("cookie"),
	);

	const {enabled, variant} = yield* Effect.gen(function* () {
		const enabled = yield* flags.getBoolean(PROBE_FLAG, false);
		const variant = yield* flags.getString(PROBE_VARIANT_FLAG, "control");
		return {enabled, variant};
	}).pipe(Effect.provideService(FlagsContext, context));

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
	// The SAME seam the edge `__BOOT__` injection uses, so the two never diverge
	// (ADR 0179 AC2), including the #2741 override-authz verdict.
	const context = yield* resolveRequestFlagsContext(session, raw.headers.get("cookie"));

	// `FlagsContext` is provided ONCE over the whole batch, not per key (ADR 0029).
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
