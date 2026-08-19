/**
 * The per-request contract, in its own neutral module so the serving path and
 * the provision pipeline depend on the contract alone, never on the
 * oracle-baseline compile module.
 */
import type {Context} from "effect";
import type {CurrentUser} from "./CurrentUser.ts";
import type {LivePublisher} from "./LivePublisher.ts";

/**
 * `requestServices` is the generic per-request provision seam (ADR 0107 §7):
 * an opaque bag of extra per-request values, provided innermost so it wins
 * over the build-time services. Opaque on purpose — the package never names
 * the app's service.
 *
 * Deliberately NO `signal` field: the worker route wires abort→interruption at
 * the platform edge (ADR 0043), so an abort knob here would only mislead
 * future route authors. Only the oracle baseline consumes one, and it extends
 * this contract locally (`ExecutorRequestContext`, `Executor.ts`).
 */
export interface FateRequestContext {
	readonly currentUser: typeof CurrentUser.Service;
	readonly livePublisher: typeof LivePublisher.Service;
	readonly requestServices?: Context.Context<never>;
}
