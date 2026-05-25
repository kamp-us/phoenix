import type {ManagedRuntime} from "effect";
import type {FateRuntime} from "./runtime";

/**
 * The per-request context fate hands to every resolver and source executor as
 * `ctx`. In phoenix it carries the request's `ManagedRuntime` (built and
 * disposed by the `/fate` Hono route — ADR 0017) and the raw `Request`.
 *
 * Session is **not** a field here. It's baked into the runtime's `Auth` layer
 * when the route builds the runtime, so resolvers read the caller with
 * `yield* Auth.required` rather than off the context.
 *
 * See `.patterns/fate-effect-bridge.md`.
 */
export interface FateContext {
	readonly runtime: ManagedRuntime.ManagedRuntime<FateRuntime.Context, never>;
	readonly request: Request;
}
