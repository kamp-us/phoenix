/**
 * What a guard answers, and how that answer becomes bytes and an exit code.
 *
 * Every guard in this group computes a {@link GuardVerdict} and hands it here. The taxonomy lives
 * once so a workflow reads the same grammar from every guard, and so the ADR 0092 floor — a scan
 * that resolved to nothing reds, never passes — is a *shape* rather than a rule each guard is
 * trusted to remember. `zeroScope` is a constructor; there is no way to build a `Clean` verdict
 * that carries no scanned scope.
 *
 * Output split, per the interface convention (`../verb.ts`): a clean run puts its one-line summary
 * on stdout, and every refusal puts the human report — plus, under Actions, the `::error` commands
 * — on stderr with stdout empty.
 */

import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {type Annotation, fallbackAnnotations, renderAnnotations} from "./annotate.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";

/**
 * A guard's answer. Five states: two exit 0, three red, and the split between the three reds is the
 * point — CI reds on all of them, a human fixing one needs to know which.
 *
 * `Skipped` and `ZeroScope` both mean the guard scanned nothing, and they are not the same answer.
 * `ZeroScope` is a scan that resolved empty when it should have resolved to something — the ADR 0092
 * red. `Skipped` is the repo having declared the guard's subject does not exist here, so there was
 * never anything to resolve; reporting that as a red would make a valid config a permanent CI
 * failure.
 */
export type GuardVerdict =
	/** The scan ran over `scanned` real units of scope and found nothing to report. */
	| {readonly _tag: "Clean"; readonly summary: string; readonly scanned: number}
	/** The repo declared this guard's subject absent, so there was nothing to scan. */
	| {readonly _tag: "Skipped"; readonly summary: string}
	/** The rule is broken. `report` names every offender; `annotations` locate them on the diff. */
	| {
			readonly _tag: "Violation";
			readonly report: string;
			readonly annotations: ReadonlyArray<Annotation>;
	  }
	/** The scope resolved empty, so a pass would be vacuous (ADR 0092). */
	| {readonly _tag: "ZeroScope"; readonly report: string}
	/** A read the verdict rests on failed. Nothing is proven — never reported as clean. */
	| {readonly _tag: "Unknown"; readonly report: string};

/** A clean run. `scanned` is what it covered, so the summary can never claim a scope it never had. */
export const clean = (summary: string, scanned: number): GuardVerdict => ({
	_tag: "Clean",
	summary,
	scanned,
});

/**
 * A guard whose subject this repo declared it does not keep. `summary` must name the declaration,
 * so nobody reads the exit 0 as a scan that passed.
 */
export const skipped = (summary: string): GuardVerdict => ({_tag: "Skipped", summary});

export const violation = (
	report: string,
	annotations: ReadonlyArray<Annotation> = [],
): GuardVerdict => ({_tag: "Violation", report, annotations});

export const zeroScope = (report: string): GuardVerdict => ({_tag: "ZeroScope", report});

export const unknown = (report: string): GuardVerdict => ({_tag: "Unknown", report});

/**
 * Build a verdict's annotations, degrading to none if the build throws.
 *
 * A guard that computes annotations from its own findings can throw while doing so — and that throw
 * would land exactly when the guard goes red, taking the human report with it. Every guard builds
 * them through this, so the worst case is a red with no inline markers rather than a crash.
 */
export const annotationsOrNone = (
	build: () => ReadonlyArray<Annotation>,
): ReadonlyArray<Annotation> => {
	try {
		return build();
	} catch {
		return [];
	}
};

/** The exit code a verdict is seated on. Exported so a test asserts the taxonomy directly. */
export const verdictCode = (verdict: GuardVerdict): number => {
	switch (verdict._tag) {
		case "Clean":
		case "Skipped":
			return 0;
		case "Violation":
			return VIOLATION;
		case "ZeroScope":
			return ZERO_SCOPE;
		case "Unknown":
			return PRECONDITION_UNKNOWN;
	}
};

/**
 * The verdict as bytes and an exit code. A `ZeroScope` or `Unknown` verdict supplies no annotations
 * of its own, so it gets the report's head as one bare `::error` — a red that renders a blank check
 * surface is the #3868 complaint verbatim.
 */
export const emitVerdict = (
	verdict: GuardVerdict,
	env: Readonly<Record<string, string | undefined>>,
): VerbOutcome => {
	if (verdict._tag === "Clean" || verdict._tag === "Skipped") return answer(verdict.summary);
	const annotations = verdict._tag === "Violation" ? verdict.annotations : [];
	const lines = renderAnnotations(fallbackAnnotations(verdict.report, annotations), env);
	const refusal = refuse(verdictCode(verdict), verdict.report);
	return {...refusal, stderr: [...refusal.stderr, ...lines]};
};
