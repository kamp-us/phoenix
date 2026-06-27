/**
 * `FateRequestContext` — the per-request contract, in its own neutral module
 * so the
 * serving path (`Interpreter.ts`, the worker route) and the provision
 * pipeline (`Provision.ts`) depend on the contract alone, never on the
 * oracle-baseline compile module.
 */
import type {Context} from "effect";
import type {CurrentUser} from "./CurrentUser.ts";
import type {LivePublisher} from "./LivePublisher.ts";

/**
 * What the caller hands a request handler: the per-request pair as VALUES —
 * `currentUser` from the validated session, `livePublisher` from the
 * request's execution context (built worker-side, e.g. via
 * `livePublisherFor`; the package never imports the implementation).
 *
 * `requestServices` is the generic per-request provision seam (ADR 0107 §7): an
 * opaque `Context.Context<never>` bag of EXTRA per-request service values an app
 * provides alongside the pair (e.g. a `CurrentActor` derived from `currentUser`),
 * provided innermost so it wins over the build-time services. Opaque keeps the
 * contract vocab-free — the package never names the app's service. The app
 * DECLARES the tags to `FateServer.layer` (so `FateServerRequirements` excludes
 * them from build-time R) and FULFILLS them by putting their values here; absent
 * ⇒ `Context.empty()`, and a declared-but-unprovided service fails loudly at run
 * ("Service not found"), like a missing `currentUser`.
 *
 * Deliberately NO `signal` field: the serving path
 * (`FateInterpreter`) leaves interruption to the caller — the worker route
 * wires the request's abort signal to fiber interruption at the platform
 * edge (ADR 0043) — so an abort knob on the served contract would only
 * mislead future route authors. The one path that does consume a signal is
 * the oracle baseline's `runPromise` conversion, and it extends this
 * contract locally (`ExecutorRequestContext`, `Executor.ts`).
 */
export interface FateRequestContext {
	readonly currentUser: typeof CurrentUser.Service;
	readonly livePublisher: typeof LivePublisher.Service;
	readonly requestServices?: Context.Context<never>;
}
