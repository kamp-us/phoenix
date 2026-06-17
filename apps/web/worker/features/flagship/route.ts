/**
 * `GET /api/flags/probe` — the end-to-end demonstrator for the boolean
 * dark-ship primitive (epic #488, #508). It reads one boolean flag through the
 * `Flags` domain service and **branches** on its value, proving the
 * infra→service→request slice serves a server-gated code path.
 *
 * It builds the per-request {@link FlagsContext} via `makeRequestFlagsContext`
 * (the session's user id for stable bucketing, plus the deploy `environment`
 * sourced from the stage — #512) and provides it inline — the per-request
 * evaluation context supplied alongside `Auth` (ADR 0029), not at isolate scope.
 * With no session it falls back to the anonymous identity. The flag is
 * undeclared, so evaluation returns the safe default (`false` → the off branch);
 * a server with the flag on would return the on branch.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {Pasaport} from "../pasaport/Pasaport.ts";
import {Flags} from "./Flags.ts";
import {anonymousFlagsContext, FlagsContext, makeRequestFlagsContext} from "./FlagsContext.ts";

/** The dark-ship flag this probe gates on — undeclared, so it reads its default. */
const PROBE_FLAG = "phoenix-flags-probe";

export const handleFlagsProbe = Effect.gen(function* () {
	const raw = yield* Cloudflare.Request;
	const pasaport = yield* Pasaport;
	const flags = yield* Flags;

	const session = yield* pasaport.validateSession(raw.headers);
	const identity = session ? {userId: session.user.id} : anonymousFlagsContext;
	// The environment attribute is sourced from the deploy stage (`ENVIRONMENT`,
	// ADR 0057), not hand-passed — so an environment-targeting rule resolves per
	// stage with no change here (#512).
	const context = yield* makeRequestFlagsContext(identity);

	// The dark-ship read: the safe default is the off path, and the call provides
	// the per-request identity context for bucketing.
	const enabled = yield* flags
		.getBoolean(PROBE_FLAG, false)
		.pipe(Effect.provideService(FlagsContext, context));

	// Branch on the flag — the whole point of the primitive.
	return HttpServerResponse.jsonUnsafe({flag: PROBE_FLAG, enabled, branch: enabled ? "on" : "off"});
});

export const flagsProbeRoute = HttpRouter.add("GET", "/api/flags/probe", handleFlagsProbe);
