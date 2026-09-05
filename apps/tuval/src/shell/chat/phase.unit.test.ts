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
import {isWorking, phaseLines, statusLine} from "./phase.ts";

const startFailure = (detail: string, reason: string): AgentFailure => ({
	tag: "tuval/ai-agent/StartError",
	reason,
	detail,
});

describe("the status line", () => {
	it("is the phase's own sentence while nothing has failed", () => {
		const phases: ReadonlyArray<Phase> = ["idle", "starting", "ready", "prompting", "gone"];
		expect(phases.map((phase) => statusLine(phase, null))).toEqual(
			phases.map((phase) => phaseLines[phase]),
		);
	});

	it("reads as pending while a start is in flight, not as never started", () => {
		expect(statusLine("starting", null)).toBe("Starting the session…");
		expect(statusLine("starting", null)).not.toBe(phaseLines.idle);
	});

	it("names the reason a start failed rather than reading as never started", () => {
		const line = statusLine(
			"idle",
			startFailure("the call did not answer within 30000ms", "deadline"),
		);
		expect(line).toContain("could not start");
		expect(line).toContain("30000ms");
		expect(line).not.toBe(phaseLines.idle);
	});

	it("names the reason a resume was refused, where that failure leaves the session", () => {
		const line = statusLine(
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
		expect(statusLine("idle", refused)).toBe(phaseLines.idle);
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
