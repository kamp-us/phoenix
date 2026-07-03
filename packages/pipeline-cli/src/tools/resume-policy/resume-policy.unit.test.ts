import {describe, expect, it} from "vitest";
import type {CrashSignal} from "../failure-classifier/failure-classifier.ts";
import {decideResume, RESUME_CAP, type ResumeLedger} from "./resume-policy.ts";

const TRANSIENT: CrashSignal = {reason: "stage review returned a null subagent result"};
const LOGIC: CrashSignal = {reason: "TypeError: Cannot read properties of undefined (reading 'x')"};
const UNKNOWN: CrashSignal = {reason: "something weird nobody has a signature for"};

const ledger = (over: Partial<ResumeLedger> = {}): ResumeLedger => ({
	resumeFromRunId: "run_1",
	scriptPath: ".claude/workflows/drive-issue.js",
	priorResumes: 0,
	...over,
});

describe("decideResume — TRANSIENT under the cap resumes with the recovery args", () => {
	it("issues {scriptPath, resumeFromRunId} from the ledger on a first TRANSIENT crash", () => {
		const a = decideResume(TRANSIENT, ledger({resumeFromRunId: "run_x", scriptPath: "wf.js"}));
		expect(a.action).toBe("resume");
		if (a.action !== "resume") throw new Error("unreachable");
		expect(a.resumeFromRunId).toBe("run_x");
		expect(a.scriptPath).toBe("wf.js");
		expect(a.attempt).toBe(1);
	});
});

describe("decideResume — LOGIC surfaces immediately with ZERO resume attempts", () => {
	it("a LOGIC crash never resumes, even at priorResumes=0", () => {
		const a = decideResume(LOGIC, ledger({priorResumes: 0}));
		expect(a.action).toBe("surface");
		if (a.action !== "surface") throw new Error("unreachable");
		expect(a.reason).toBe("logic");
		expect(a.class).toBe("logic");
	});

	it("an unrecognized crash default-denies to LOGIC → surface, zero resumes", () => {
		const a = decideResume(UNKNOWN, ledger({priorResumes: 0}));
		expect(a.action).toBe("surface");
		if (a.action !== "surface") throw new Error("unreachable");
		expect(a.reason).toBe("logic");
	});
});

describe("decideResume — the cap: at most K resumes of one run, then surface", () => {
	it("caps at RESUME_CAP (=2) — priorResumes at the cap surfaces as cap-reached", () => {
		const a = decideResume(TRANSIENT, ledger({priorResumes: RESUME_CAP}));
		expect(a.action).toBe("surface");
		if (a.action !== "surface") throw new Error("unreachable");
		expect(a.reason).toBe("cap-reached");
		// A cap-reached surface is still a TRANSIENT classification — the cap, not the class, stops it.
		expect(a.class).toBe("transient");
	});

	it("RESUME_CAP is 2 (the ADR-0130 K)", () => {
		expect(RESUME_CAP).toBe(2);
	});

	// ACCEPTANCE: drive 3 consecutive TRANSIENT failures on ONE run → exactly 2 resumes then a surface.
	it("3 consecutive TRANSIENT crashes of one run → exactly 2 resumes then a surface", () => {
		let priorResumes = 0;
		const runId = "run_flaky";
		const outcomes: string[] = [];
		for (let crash = 1; crash <= 3; crash++) {
			const a = decideResume(TRANSIENT, ledger({resumeFromRunId: runId, priorResumes}));
			outcomes.push(a.action);
			if (a.action === "resume") {
				// The caller persists the incremented count as the run's new priorResumes.
				expect(a.attempt).toBe(priorResumes + 1);
				priorResumes = a.attempt;
			}
		}
		expect(outcomes).toEqual(["resume", "resume", "surface"]);
		expect(priorResumes).toBe(RESUME_CAP); // exactly 2 resumes accrued
	});
});

describe("decideResume — the cap is counted PER resumeFromRunId (fresh run → fresh K budget)", () => {
	it("a fresh run (new id, priorResumes=0) resumes even after another run hit the cap", () => {
		// run_A is exhausted at the cap → surface.
		const exhausted = decideResume(TRANSIENT, ledger({resumeFromRunId: "run_A", priorResumes: 2}));
		expect(exhausted.action).toBe("surface");
		// run_B is a different run with its own zeroed budget → resumes.
		const fresh = decideResume(TRANSIENT, ledger({resumeFromRunId: "run_B", priorResumes: 0}));
		expect(fresh.action).toBe("resume");
		if (fresh.action !== "resume") throw new Error("unreachable");
		expect(fresh.resumeFromRunId).toBe("run_B");
		expect(fresh.attempt).toBe(1);
	});

	it("each run gets its own full 2-resume budget independent of siblings", () => {
		const drive = (runId: string): string[] => {
			let priorResumes = 0;
			const outcomes: string[] = [];
			for (let crash = 1; crash <= 3; crash++) {
				const a = decideResume(TRANSIENT, ledger({resumeFromRunId: runId, priorResumes}));
				outcomes.push(a.action);
				if (a.action === "resume") priorResumes = a.attempt;
			}
			return outcomes;
		};
		expect(drive("run_1")).toEqual(["resume", "resume", "surface"]);
		expect(drive("run_2")).toEqual(["resume", "resume", "surface"]);
	});
});

describe("decideResume — total: every input yields exactly one resume|surface, never resume off-class", () => {
	it("no non-TRANSIENT class ever resumes, at any prior count", () => {
		for (const priorResumes of [0, 1, 2, 5]) {
			expect(decideResume(LOGIC, ledger({priorResumes})).action).toBe("surface");
			expect(decideResume(UNKNOWN, ledger({priorResumes})).action).toBe("surface");
			expect(decideResume({}, ledger({priorResumes})).action).toBe("surface");
		}
	});
});
