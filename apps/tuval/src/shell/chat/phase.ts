/**
 * The phase line: one sentence per `Phase`, and whether that phase means a turn is running.
 *
 * A `Record<Phase, …>` rather than a `switch`, so a seventh phase added to the union is a compile
 * error here instead of a window that silently renders nothing for it. The copy is English because
 * only Tuval, Fabrika and Demlik are Turkish (`.glossary/LANGUAGE.md`); the window says "the agent"
 * and never names a backend, which is what lets one window render any of them.
 */

import type {AgentFailure, Interruption} from "../../ai-agent/core/index.ts";
import type {Phase} from "../../ai-agent/events.ts";

/**
 * `StartError`'s tag, as a literal for the same reason `ai-agent/core/failures.ts` writes them as
 * literals: every agent import from this directory is type-only, so the window carries no agent
 * code into the browser bundle. `boundary.unit.test.ts` reds if this stops naming a declared tag.
 */
const START_ERROR = "tuval/ai-agent/StartError";
/** `InterruptError`'s tag, on the same terms — the refused abort of ADR 0356. */
const INTERRUPT_ERROR = "tuval/ai-agent/InterruptError";

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
 * How long an unanswered interruption reads as merely in flight before the window says the outcome
 * is unknown. Five seconds is a working guess, not a measurement — no real CLI abort has been
 * timed (#8007). What it must not be is absent: an abort nothing confirms would otherwise leave the
 * window on "Working" forever with no account of the request the operator made.
 */
export const interruptionGraceMillis = 5_000;

/**
 * What an outstanding interruption reads as, before and after the grace runs out.
 *
 * The second line is deliberately not a claim that the turn is still running: nothing has answered
 * the abort either way, so "not confirmed" is the whole of what is known and saying more would be
 * inventing it. A backend that *did* answer — by refusing — reads the refusal instead
 * (`interruptRefusedLine`), which is the case this line no longer has to cover (ADR 0356).
 */
const interruptionLine = (interruption: Interruption, now: number): string =>
	now - interruption.requestedAt < interruptionGraceMillis
		? "Interrupting — waiting for the agent to confirm…"
		: "Interrupting — the agent has not confirmed. The turn may still be running.";

export interface Status {
	readonly phase: Phase;
	readonly failure: AgentFailure | null;
	readonly interruption: Interruption | null;
	/** The window's own clock, read at render, so this function stays pure and testable. */
	readonly now: number;
}

/** The backend answered the abort, and the answer was no. Read only while the turn is still on. */
const interruptRefusedLine = (failure: AgentFailure): string =>
	`Interrupting — the agent refused to stop — ${failure.detail}`;

/**
 * The phase line, or what went wrong when the phase alone would misreport it.
 *
 * An outstanding interruption outranks the plain phase line: the session really is still on the
 * turn, but "Working — Escape interrupts." is the wrong sentence to show someone who already
 * pressed Escape (#8007). A refused abort outranks that in turn — a backend that said no is not the
 * same fact as one that has not answered, which is the readout ADR 0356 buys.
 *
 * Only a `StartError` earns the failure line, and only where the session came to rest: any other
 * refusal is about one act (a prompt, a mode, an answer) rather than about the session, and the
 * phase is still the true thing to say.
 */
export const statusLine = (status: Status): string => {
	if (status.phase === "prompting" && status.failure?.tag === INTERRUPT_ERROR) {
		return interruptRefusedLine(status.failure);
	}
	if (status.interruption !== null && status.phase === "prompting") {
		return interruptionLine(status.interruption, status.now);
	}
	const lead = startFailedLeads[status.phase];
	return status.failure === null || status.failure.tag !== START_ERROR || lead === undefined
		? phaseLine(status.phase)
		: `${lead} — ${status.failure.detail}`;
};

/**
 * Is a turn running? The composer's stop control and its Escape-to-interrupt branch both key on
 * this, and so does the phase line's own status role.
 */
export const isWorking = (phase: Phase): boolean => phase === "prompting";
