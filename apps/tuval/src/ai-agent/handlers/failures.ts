/**
 * The one crossing point between the layer's typed errors and the core's `AgentFailure` data.
 *
 * Ruling 3 (#7570) makes the error tag the thing the window renders by, so a failure crosses as
 * `{tag, reason, detail}` and the class instance stops here: an error class is not something a
 * checkpoint can carry, and letting one into a Msg would put a non-plain value on the core's data
 * surfaces, which `core/boundary.unit.test.ts` reds on.
 *
 * A deadline is not one of the layer's errors — it is the row's declared policy firing — so it is
 * written against the tag of the call that timed out, with that call's own transport-ish reason.
 */

import {Cause} from "effect";
import type {AgentFailure} from "../core/index.ts";
import {
	ModelUnsupported,
	ModeUnsupported,
	type PageError,
	type PromptError,
	type StartError,
	type TransportError,
	UnknownRequest,
} from "../service/index.ts";

/** Every error class the interface declares, as the handlers see them on one channel. */
export type AgentServiceError =
	| StartError
	| PromptError
	| UnknownRequest
	| ModeUnsupported
	| ModelUnsupported
	| PageError
	| TransportError;

/** The three classes that enumerate no `reason` case; every other one carries its own. */
const reasonOf = (error: AgentServiceError): string | null =>
	error instanceof UnknownRequest ||
	error instanceof ModeUnsupported ||
	error instanceof ModelUnsupported
		? null
		: error.reason;

export const failureOf = (error: AgentServiceError): AgentFailure => ({
	tag: error._tag,
	reason: reasonOf(error),
	detail: error.message,
});

/**
 * A timeout written as the failing call's own tag. `deadline` is not one of the `reason` literals
 * any error class enumerates, and that is deliberate: the window renders by tag, and the reason
 * says which side of the policy gave up.
 */
export const deadlineFailure = (tag: string, millis: number): AgentFailure => ({
	tag,
	reason: "deadline",
	detail: `the call did not answer within ${millis}ms`,
});

export const isTimeout = (error: unknown): error is Cause.TimeoutError =>
	Cause.isTimeoutError(error);
