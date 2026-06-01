import type * as ManagedRuntime from "effect/ManagedRuntime";
import type {LiveBus} from "../fate-live/event-bus.ts";
import type {Auth} from "../pasaport/Auth.ts";
import type {WorkerFateServices} from "./layers.ts";

/**
 * The per-request context fate hands to every resolver and source executor as
 * `ctx`.
 *
 * The F4 shape: ONE worker-level `ManagedRuntime` (built once per isolate in
 * worker init from the fate layer — `Drizzle` + the feature services) carries
 * the {@link WorkerFateServices}, and the two genuinely per-request services ride
 * here as VALUES — `auth` (the validated session) and `liveBus` (the publish
 * capability, ADR 0039). The bridge (`effect.ts`) provides `auth`/`liveBus` onto
 * EACH resolver effect with `Effect.provideService` and runs it on `runtime`, so
 * resolver spans nest under the runtime's request span and nothing is built or
 * disposed per request.
 *
 * Carrying the two service VALUES (rather than a captured `Context` or a bundled
 * `provideRequest` closure) makes the per-request contract explicit and invalid
 * states unrepresentable: a `FateContext` cannot exist without both, and the
 * bridge cannot forget to provide one.
 *
 * `request` is the raw `Request` for the rare resolver/source that needs headers
 * directly (fate also forwards it). Session is NOT a field — it's inside `auth`,
 * read with `yield* Auth.required`.
 *
 * See `.patterns/fate-effect-bridge.md` and `.patterns/alchemy-runtime.md`.
 */
export interface FateContext {
	/** The worker-level runtime carrying {@link WorkerFateServices}; one per isolate. */
	readonly runtime: ManagedRuntime.ManagedRuntime<WorkerFateServices, never>;
	/** The raw request, for resolvers/sources that read headers directly. */
	readonly request: Request;
	/** The per-request validated session, provided onto each resolver effect. */
	readonly auth: typeof Auth.Service;
	/** The per-request publish capability (ADR 0039), provided onto each resolver effect. */
	readonly liveBus: typeof LiveBus.Service;
}
