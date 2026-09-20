/**
 * The status line: what the bar says for each phase, and when the phase alone would misreport it.
 *
 * The case that forced this is a start that failed its 30 s deadline (#7962): `phaseAfterFailure`
 * walks a failed `starting` back to `idle`, which reads as "Not started." — the same sentence a
 * session nobody ever started reads as, with the reason nowhere on screen.
 */

import {describe, expect, it} from "vitest";
import type {AgentFailure} from "../../ai-agent/core/index.ts";
import type {Phase} from "../../ai-agent/events.ts";
import {interruptionGraceMillis, isWorking, phaseLines, statusLine, workingTell} from "./phase.ts";

const startFailure = (detail: string, reason: string): AgentFailure => ({
	tag: "tuval/ai-agent/StartError",
	reason,
	detail,
});

const NOW = 1_700_000_000_000;

/** The line for a session with nothing in flight, so each case names only what it is about. */
const lineOf = (
	phase: Phase,
	failure: AgentFailure | null,
	over: {readonly requestedAt: number; readonly now: number} | null = null,
): string =>
	statusLine({
		phase,
		failure,
		interruption: over === null ? null : {requestedAt: over.requestedAt},
		now: over === null ? NOW : over.now,
	});

describe("the status line", () => {
	it("is the phase's own sentence while nothing has failed", () => {
		const phases: ReadonlyArray<Phase> = ["idle", "starting", "ready", "prompting", "gone"];
		expect(phases.map((phase) => lineOf(phase, null))).toEqual(
			phases.map((phase) => phaseLines[phase]),
		);
	});

	it("reads as pending while a start is in flight, not as never started", () => {
		expect(lineOf("starting", null)).toBe("Starting the session…");
		expect(lineOf("starting", null)).not.toBe(phaseLines.idle);
	});

	it("names the reason a start failed rather than reading as never started", () => {
		const line = lineOf("idle", startFailure("the call did not answer within 30000ms", "deadline"));
		expect(line).toContain("could not start");
		expect(line).toContain("30000ms");
		expect(line).not.toBe(phaseLines.idle);
	});

	it("names the reason a resume was refused, where that failure leaves the session", () => {
		const line = lineOf(
			"gone",
			startFailure('no session "abc" is stored for this working directory', "session-not-found"),
		);
		expect(line).toContain("no session");
	});

	// A refused prompt, a refused mode, an unknown card: each is about one act rather than about the
	// session, so the phase is still the true thing the bar can say.
	it("leaves a failure that is not a start's to the surface that owns it", () => {
		const refused: AgentFailure = {
			tag: "tuval/ai-agent/PromptError",
			reason: "no-session",
			detail: "the session is idle, not ready",
		};
		expect(lineOf("idle", refused)).toBe(phaseLines.idle);
	});

	// #8007: the session is legitimately still `prompting` after an interrupt was asked for, and
	// "Working — Escape interrupts." is the wrong sentence to show someone who already pressed it.
	it("says an interruption is outstanding rather than repeating the working line", () => {
		const line = lineOf("prompting", null, {requestedAt: NOW, now: NOW + 1_000});
		expect(line).toContain("Interrupting");
		expect(line).not.toBe(phaseLines.prompting);
	});

	it("stops calling a long-unanswered interruption merely pending", () => {
		const waiting = lineOf("prompting", null, {requestedAt: NOW, now: NOW + 1_000});
		const unknown = lineOf("prompting", null, {
			requestedAt: NOW,
			now: NOW + interruptionGraceMillis,
		});
		expect(unknown).not.toBe(waiting);
		expect(unknown).toContain("has not confirmed");
	});

	// Neither line may read as a finished turn: the outcome is unknown, and a window that says
	// "Ready." over an unanswered abort is the misreport #8007 is about.
	it("never presents an outstanding interruption as a completed turn", () => {
		for (const elapsed of [0, 1_000, interruptionGraceMillis, interruptionGraceMillis * 100]) {
			const line = lineOf("prompting", null, {requestedAt: NOW, now: NOW + elapsed});
			expect(line).not.toBe(phaseLines.ready);
		}
	});

	it("goes back to the phase's own sentence once the interruption is settled", () => {
		expect(lineOf("ready", null)).toBe(phaseLines.ready);
	});

	// ADR 0356: the backend answered the abort by refusing, which "has not confirmed" reports as
	// silence. The operator whose desk froze on 2026-09-05 read exactly that sentence.
	it("says the agent refused to stop rather than that it has not confirmed", () => {
		const refused: AgentFailure = {
			tag: "tuval/ai-agent/InterruptError",
			reason: "turn-running",
			detail: "the agent transport failed (refused): Operation aborted",
		};
		const line = statusLine({
			phase: "prompting",
			failure: refused,
			interruption: {requestedAt: NOW},
			now: NOW + interruptionGraceMillis,
		});
		expect(line).toContain("refused to stop");
		expect(line).toContain("Operation aborted");
		expect(line).not.toContain("has not confirmed");
	});

	// The refusal is about the turn that was running; once the session is off it, the phase is the
	// true thing to say and a stale refusal must not outlive it.
	it("stops reading the refusal once the session is off the turn", () => {
		const refused: AgentFailure = {
			tag: "tuval/ai-agent/InterruptError",
			reason: "no-live-turn",
			detail: "Operation aborted",
		};
		expect(lineOf("ready", refused)).toBe(phaseLines.ready);
	});

	it("says a turn is running for prompting and for nothing else", () => {
		const phases: ReadonlyArray<Phase> = [
			"idle",
			"starting",
			"ready",
			"prompting",
			"reconnecting",
			"gone",
		];
		expect(phases.filter(isWorking)).toEqual(["prompting"]);
	});
});

/**
 * The tell under the transcript, which renders beside the bar while a turn runs. The two are read
 * as one readout, so a refusal the bar names has to reach this word too (#8007).
 */
describe("the working tell", () => {
	const refused: AgentFailure = {
		tag: "tuval/ai-agent/InterruptError",
		reason: "turn-running",
		detail: "the agent transport failed (refused): Operation aborted",
	};

	const tellOf = (failure: AgentFailure | null, interruption: number | null): string =>
		workingTell({
			phase: "prompting",
			failure,
			interruption: interruption === null ? null : {requestedAt: interruption},
			now: NOW,
		});

	it("says the turn is working while no abort has been asked for", () => {
		expect(tellOf(null, null)).toBe("Working…");
	});

	it("says an unanswered abort is interrupting", () => {
		expect(tellOf(null, NOW)).toBe("Interrupting…");
	});

	// The contradiction this closes: the bar said the agent refused to stop while this word still
	// claimed an abort was in flight.
	it("stops claiming an abort is in flight once the agent has refused it", () => {
		expect(tellOf(refused, NOW)).toContain("refused");
		expect(tellOf(refused, NOW)).not.toBe("Interrupting…");
	});

	it("is not read by a failure about some other act", () => {
		expect(tellOf(startFailure("the call did not answer", "transport"), NOW)).toBe("Interrupting…");
	});
});
