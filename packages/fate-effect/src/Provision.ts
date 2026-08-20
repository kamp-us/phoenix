/**
 * `provideRequestPair` — THE per-request provision pipeline, spelled once (consumed by
 * `Executor.ts`, `Interpreter.ts` and `Walk.ts`).
 *
 * The invariant: the per-request services come off the request context as VALUES and are provided
 * innermost, so a request value always wins over the build-time services `FateServer.layer`
 * captured. No per-request layer, no runtime rebuild, no context smuggling. The generic
 * `context.requestServices` seam between them is ADR 0107 §7; `RequestContext.ts` has the contract.
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

export type ProvideRequestPair = <A, E>(
	effect: Effect.Effect<A, E, unknown>,
) => Effect.Effect<A, E>;

export const provideRequestPair =
	(context: FateRequestContext, services: Context.Context<never>): ProvideRequestPair =>
	<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
		effect.pipe(
			Effect.provideService(CurrentUser, context.currentUser),
			Effect.provideService(LivePublisher, context.livePublisher),
			Effect.provideContext(context.requestServices ?? Context.empty()),
			Effect.provideContext(services),
		) as Effect.Effect<A, E>;
