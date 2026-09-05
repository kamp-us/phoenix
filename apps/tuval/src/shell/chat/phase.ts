/**
 * The phase line: one sentence per `Phase`, and whether that phase means a turn is running.
 *
 * A `Record<Phase, …>` rather than a `switch`, so a seventh phase added to the union is a compile
 * error here instead of a window that silently renders nothing for it. The copy is English because
 * only Tuval, Fabrika and Demlik are Turkish (`.glossary/LANGUAGE.md`); the window says "the agent"
 * and never names a backend, which is what lets one window render any of them.
 */

import type {Phase} from "../../ai-agent/events.ts";

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
 * Is a turn running? The composer's stop control and its Escape-to-interrupt branch both key on
 * this, and so does the phase line's own status role.
 */
export const isWorking = (phase: Phase): boolean => phase === "prompting";
