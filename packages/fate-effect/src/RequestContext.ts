/**
 * `FateRequestContext` — the per-request contract, in its own neutral module
 * (review fix, tasks.md task 20; previously declared in `Executor.ts`) so the
 * serving path (`Interpreter.ts`, the worker route) and the provision
 * pipeline (`Provision.ts`) depend on the contract alone, never on the
 * oracle-baseline compile module.
 */
import type {CurrentUser} from "./CurrentUser.ts";
import type {LivePublisher} from "./LivePublisher.ts";

/**
 * What the caller hands a request handler: the per-request pair as VALUES —
 * `currentUser` from the validated session, `livePublisher` from the
 * request's execution context (built worker-side, e.g. via
 * `livePublisherFor`; the package never imports the implementation).
 *
 * Deliberately NO `signal` field (audit fix A1): the serving path
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
}
