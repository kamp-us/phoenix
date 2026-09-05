/**
 * The phase line: one sentence per `Phase`, and whether that phase means a turn is running.
 *
 * A `Record<Phase, …>` rather than a `switch`, so a seventh phase added to the union is a compile
 * error here instead of a window that silently renders nothing for it. The copy is English because
 * only Tuval, Fabrika and Demlik are Turkish (`.glossary/LANGUAGE.md`); the window says "the agent"
 * and never names a backend, which is what lets one window render any of them.
 */

import type {AgentFailure} from "../../ai-agent/core/index.ts";
import type {Phase} from "../../ai-agent/events.ts";

/**
 * `StartError`'s tag, as a literal for the same reason `ai-agent/core/failures.ts` writes them as
 * literals: every agent import from this directory is type-only, so the window carries no agent
 * code into the browser bundle. `boundary.unit.test.ts` reds if this stops naming a declared tag.
 */
const START_ERROR = "tuval/ai-agent/StartError";

export const phaseLines: Readonly<Record<Phase, string>> = {
	idle: "Not started.",
	starting: "Starting the session…",
	ready: "Ready.",
	prompting: "Working — Escape interrupts.",
	reconnecting: "Reconnecting…",
	gone: "The session is gone.",
};

export const phaseLine = (phase: Phase): string => phaseLines[phase];

/**
 * The lead a failed start reads under, per phase the failure left the session in.
 *
 * `phaseAfterFailure` (`ai-agent/core/machine.ts`) walks a failed `starting` back to `idle` and a
 * refused resume to `gone`, and both then render the phase's own sentence — so the 30 s start
 * deadline reads as "Not started.", which is what a session nobody ever started reads as (#7962).
 */
const startFailedLeads: Readonly<Partial<Record<Phase, string>>> = {
	idle: "The session could not start",
	gone: "The session is gone",
};

/**
 * The phase line, or what went wrong when the phase alone would misreport it.
 *
 * Only a `StartError` earns the failure line, and only where the session came to rest: any other
 * refusal is about one act (a prompt, a mode, an answer) rather than about the session, and the
 * phase is still the true thing to say.
 */
export const statusLine = (phase: Phase, failure: AgentFailure | null): string => {
	const lead = startFailedLeads[phase];
	return failure === null || failure.tag !== START_ERROR || lead === undefined
		? phaseLine(phase)
		: `${lead} — ${failure.detail}`;
};

/**
 * Is a turn running? The composer's stop control and its Escape-to-interrupt branch both key on
 * this, and so does the phase line's own status role.
 */
export const isWorking = (phase: Phase): boolean => phase === "prompting";
