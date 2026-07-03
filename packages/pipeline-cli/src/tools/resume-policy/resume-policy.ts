/**
 * `resume-policy` core — the pure, IO-free decision that turns a crashed dynamic
 * Workflow's `status: failed` event into either an auto-resume or a surface-to-human,
 * with a hard K-cap on how many times ONE run may be resumed (ADR 0130, epic #1751,
 * child #1759).
 *
 * This is the capped auto-resume MECHANISM that the ADR-0130 main-loop discipline runs:
 * the workflow-driving session detects a crash, feeds the crash signal + the per-run
 * attempt ledger through `decideResume` here, and does exactly what the returned action
 * says — re-invoke with `{scriptPath, resumeFromRunId}` (completed `agent()` stages
 * replay from the journal cache) or stop and surface.
 *
 * THE POLICY, in one line: **auto-resume iff TRANSIENT and under the cap; else surface.**
 *
 *   - The crash class is decided by SIBLING #1758's `classify()` — composed, NOT
 *     reimplemented here. TRANSIENT is the only resumable class; LOGIC (which includes
 *     every default-deny, so any unrecognized/ambiguous crash) surfaces immediately with
 *     ZERO resume attempts.
 *   - The cap is K=2 resumes PER `resumeFromRunId`. A run may be auto-resumed at most
 *     twice; a third consecutive TRANSIENT crash of the SAME run surfaces. A persistent
 *     "transient" is a masked LOGIC error, so the cap bounds token burn even when the
 *     classifier is optimistically wrong — the load-bearing safety property (ADR 0130).
 *   - The count is tracked PER RUN: a fresh run (a new `resumeFromRunId`) starts a fresh
 *     K budget. K counts resumes of the same run, not a global attempt tally.
 *
 * The core holds only the decision over plain values — no disk, no network, no real
 * workflow spawn (the core-in-its-own-file idiom; the `failure-classifier` sibling shape,
 * CLAUDE.md "Node over Python"). `command.ts` is the thin CLI bin that reads the crash
 * signal + the prior attempt count and prints the action. That split is what makes
 * "resume up to K then surface" unit-testable WITHOUT spawning real workflows.
 */
import {
	type CrashSignal,
	classify,
	type FailureClass,
} from "../failure-classifier/failure-classifier.ts";

/** The K-cap: a single run is auto-resumed at most this many times, then surfaced. */
export const RESUME_CAP = 2;

/**
 * The prior resume ledger for the crashing run: how many times THIS `resumeFromRunId`
 * has already been auto-resumed. Zero on a run's first crash (never resumed yet). The
 * caller owns persistence of this count across invocations (a per-run map / a file in the
 * driving session); the core is pure over the value it's handed. Keyed per run is what
 * makes a fresh run start a fresh K budget — the caller looks the count up by
 * `resumeFromRunId`, so a new id is absent ⇒ 0.
 */
export interface ResumeLedger {
	/** The crashed run's id — the `resumeFromRunId` a resume would replay from. */
	readonly resumeFromRunId: string;
	/** The workflow script to re-invoke on a resume (from the `<recovery>` block). */
	readonly scriptPath: string;
	/** How many times THIS run has already been auto-resumed (0 on its first crash). */
	readonly priorResumes: number;
}

/**
 * The action the driving session must take. Exactly two shapes so a caller can `switch`
 * on `.action` with no third "maybe" a reader could treat as safe-to-resume:
 *   - `resume` — re-invoke the workflow with `{scriptPath, resumeFromRunId}`; `attempt`
 *     is the 1-based number of THIS resume (the caller persists it as the run's new
 *     `priorResumes`).
 *   - `surface` — stop; hand the crash to a human. Carries WHY (logic vs cap).
 */
export type ResumeAction =
	| {
			readonly action: "resume";
			readonly scriptPath: string;
			readonly resumeFromRunId: string;
			/** 1-based index of this resume (`priorResumes + 1`); ≤ RESUME_CAP by construction. */
			readonly attempt: number;
			readonly rationale: string;
	  }
	| {
			readonly action: "surface";
			/** WHY we surfaced — a LOGIC classification, or the TRANSIENT cap reached. */
			readonly reason: "logic" | "cap-reached";
			/** The crash class that drove the decision (a cap-reached surface is still TRANSIENT). */
			readonly class: FailureClass;
			readonly rationale: string;
	  };

/**
 * Decide what to do with a crashed run. Composes #1758's `classify()` for the class, then
 * applies the cap. The two gates, in order:
 *
 *   1. **Class gate.** If `classify(signal)` is not `transient` (LOGIC — including every
 *      default-deny), SURFACE immediately with ZERO resume attempts. A blind resume of a
 *      deterministic re-crash is a token-burning loop.
 *   2. **Cap gate.** The class is TRANSIENT. If this run has already been resumed
 *      `RESUME_CAP` times (`priorResumes >= RESUME_CAP`), SURFACE (`cap-reached`) — a
 *      persistent "transient" is a masked LOGIC error and must not loop forever.
 *      Otherwise RESUME, at `attempt = priorResumes + 1`.
 *
 * Pure and total: every input yields exactly one `resume` or `surface`. There is no path
 * from a non-TRANSIENT class, nor from an at-cap run, to a `resume`.
 */
export const decideResume = (signal: CrashSignal, ledger: ResumeLedger): ResumeAction => {
	const verdict = classify(signal);

	if (verdict.class !== "transient") {
		return {
			action: "surface",
			reason: "logic",
			class: verdict.class,
			rationale: `classified LOGIC — surface immediately, zero resume attempts (${verdict.rationale})`,
		};
	}

	// TRANSIENT. Cap the resumes of THIS run so an optimistic misclassification can't loop.
	if (ledger.priorResumes >= RESUME_CAP) {
		return {
			action: "surface",
			reason: "cap-reached",
			class: "transient",
			rationale:
				`classified TRANSIENT but run ${ledger.resumeFromRunId} has already been auto-resumed ` +
				`${ledger.priorResumes} time(s) (cap K=${RESUME_CAP}) — surface. A persistent "transient" ` +
				`is a masked LOGIC error; the cap bounds token burn (ADR 0130).`,
		};
	}

	const attempt = ledger.priorResumes + 1;
	return {
		action: "resume",
		scriptPath: ledger.scriptPath,
		resumeFromRunId: ledger.resumeFromRunId,
		attempt,
		rationale:
			`classified TRANSIENT and under the cap (resume ${attempt}/${RESUME_CAP} for run ` +
			`${ledger.resumeFromRunId}) — re-invoke {scriptPath, resumeFromRunId}; completed stages ` +
			`replay from the journal cache. (${verdict.rationale})`,
	};
};
