/**
 * `provideRequestPair` — THE per-request provision pipeline, spelled once
 * (consumed by `Executor.ts` `runResolve`, `Interpreter.ts` `runOperation`,
 * and `Walk.ts` `provide`).
 *
 * The invariant, in one place: the two genuinely per-request services come
 * off the request context as VALUES — `CurrentUser` from the session,
 * `LivePublisher` from the request's execution context — provided innermost
 * so the request values always win; the build-time services captured by
 * `FateServer.layer` (`service.services`) sit beneath. No per-request layer,
 * no runtime rebuild, no context smuggling.
 *
 * Between the pair and the build-time services sits the generic per-request
 * provision seam (ADR 0107 §7): `context.requestServices`, an opaque bag of
 * EXTRA per-request service VALUES the app provides, provided over the
 * build-time `services` so a per-request value wins there too. See
 * `RequestContext.ts` for the contract.
 *
 * erased→kernel: the trailing cast re-pins the erased entry effect's
 * requirements to `never` so a runtime can run it. The erased shapes carry
 * `R = unknown` (the covariant top — every entry assigns into the config
 * records); the REAL requirements were enforced where they are enforceable:
 * the handler's own definition site typed them, `FateServer.layer`'s public
 * R surfaced their union minus the per-request pair, and the layer could not
 * have produced a runtime without discharging it. A genuinely missing
 * service still fails loudly at run time ("Service not found"), never
 * silently. This is the package's ONE spelling of that request-pipeline
 * re-pin — the call sites carry none.
 *
 * Package-internal: not exported from the barrel (no exported value's type
 * surfaces it; the repo-root typecheck gate guards TS2883).
 */
import {Context, Effect} from "effect";
import {CurrentUser} from "./CurrentUser.ts";
import {LivePublisher} from "./LivePublisher.ts";
import type {FateRequestContext} from "./RequestContext.ts";

/**
 * The applied form: what one request's provision pipeline looks like to a
 * call site (`Walk.ts` builds it once per request; the dispatch loop and the
 * v1 compiler apply it per operation).
 */
export type ProvideRequestPair = <A, E>(
	effect: Effect.Effect<A, E, unknown>,
) => Effect.Effect<A, E>;

/**
 * Close over one request's pair + the captured build-time services; the
 * returned function takes an erased entry effect to a runnable one
 * (`R: unknown → never`, see the module doc).
 */
export const provideRequestPair =
	(context: FateRequestContext, services: Context.Context<never>): ProvideRequestPair =>
	<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
		effect.pipe(
			Effect.provideService(CurrentUser, context.currentUser),
			Effect.provideService(LivePublisher, context.livePublisher),
			Effect.provideContext(context.requestServices ?? Context.empty()),
			Effect.provideContext(services),
		) as Effect.Effect<A, E>;
