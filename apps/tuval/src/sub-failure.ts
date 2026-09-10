/**
 * ADR 0346's Sub-failure policy as a type neither slice owns: `src/registry/` writes a program row
 * against it and `src/host/` runs it. It sits here rather than in the host because the registry
 * describes a program and never runs one, so it imports nothing from the host slice — the founder's
 * 2026-09-05 ruling on #7933.
 */

import type {Sub} from "@demlik/tea";

/**
 * A Sub fiber's failure as the reducer sees it: plain data, so the machine stays pure. ADR 0346
 * makes the absence of a `Cause`, an `Error` instance, a Fiber or a Scope here a binding
 * constraint — the full `Cause` goes to `onError` under `"sub-fiber"` and stops there.
 */
export interface SubFailure {
	readonly id: string;
	readonly type: string;
	/** `"failure"` is the handler's error channel; `"defect"` is a throw or a die. */
	readonly reason: "failure" | "defect";
	readonly message: string;
}

/**
 * What a failed Sub becomes (ADR 0346). Returning a Msg hands the failure to `update`; returning
 * `undefined`, or declaring nothing, ends the process instead.
 */
export type SubFailurePolicy<M, U extends Sub> = (sub: U, failure: SubFailure) => M | undefined;
