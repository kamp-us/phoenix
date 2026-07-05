/**
 * `drive-issue` single-subagent resume cap — the pure, IO-free decision that bounds how
 * many times ONE **healthy, non-crashing** subagent may be resumed before the orchestrator
 * replaces it with a fresh spawn (ADR 0152 mitigation (b), issue #2053).
 *
 * ## Why this exists — and why it is NOT #1751's crash budget
 *
 * The #1876 confabulation near-miss was a subagent that **did not crash**: a triager was
 * resumed across many cycles (~5000s cumulative, 20+ tool calls per cycle) and degraded
 * toward confident-but-confabulated output on a late resume cycle. Confabulation correlates
 * with very long resume chains, not with crashes — so nothing in the crash-recovery
 * machinery covers it. This cap is the **lifetime-degradation axis**.
 *
 * It is deliberately **distinct from #1751 / ADR 0130** (`resume-policy.ts`), which governs
 * the **crash axis**: `decideResume` only fires on a `status: failed` event, classifies the
 * crash (TRANSIENT vs LOGIC), and caps resumes of a **crashed** run at `RESUME_CAP = 2` per
 * `resumeFromRunId`. That is crash recovery. This decision fires on a **healthy** resume
 * request — no crash, no null return — and bounds the number of healthy resume cycles of a
 * single subagent before a fresh spawn. The two axes compose WITHOUT overlap and WITHOUT
 * double-counting:
 *
 *   - A **crash** resume is accounted by `resume-policy` against the crash budget (K=2).
 *   - A **healthy** resume is accounted here against the lifetime cap (K below).
 *   - A single resume is one axis or the other — never both — so neither budget weakens the
 *     other and a resume never double-counts across the two.
 *
 * ## The rule, in one line
 *
 * A healthy subagent is resumed at most `HEALTHY_RESUME_CAP` times; on the next resume
 * request past the cap the orchestrator **spawns a fresh instance** instead of resuming the
 * degraded one. A fresh spawn zeroes the count, so the successor gets its own full budget.
 *
 * This is the pure core (the `post-build.ts` / `resume-policy.ts` sibling shape): the
 * orchestrator `.claude/workflows/drive-issue.js` inlines the identical one-line predicate
 * because a workflow script — top-level `return` + injected globals — is not importable as a
 * module; this module is its canonical mirror and the one that carries the unit test, so
 * "resume up to K healthy cycles then spawn fresh" is verifiable without a real workflow.
 */

/**
 * The lifetime cap: a single healthy subagent is resumed at most this many times, then
 * replaced by a fresh spawn (ADR 0152 mitigation (b)).
 *
 * ## Rationale for K = 5
 *
 * The #1876 near-miss degraded on a late cycle of a chain that ran ~20+ tool calls per cycle
 * across roughly five-plus resumes (~5000s cumulative). K = 5 keeps a healthy subagent's
 * resume chain comfortably short of that demonstrated degradation window while still allowing
 * the ordinary multi-cycle work a single spawn legitimately does (a resume is a cheap journal
 * replay; a fresh spawn eats a cold start). It is a deliberately conservative bound on the
 * lifetime axis — distinct from #1751's K = 2 crash budget, which is tighter because a
 * *crashed* run that keeps crashing is a masked-LOGIC signal, whereas a *healthy* run that
 * keeps working is not itself a defect until the chain grows long enough to correlate with
 * confabulation.
 */
export const HEALTHY_RESUME_CAP = 5;

/**
 * The per-subagent healthy-resume ledger. `cycles` is how many times THIS subagent instance
 * has already been resumed while healthy — 0 on a fresh spawn (never resumed yet). The
 * orchestrator / driving session owns persistence of this count, keyed per subagent instance
 * (its `resumeFromRunId` / spawn id), so a **fresh spawn starts a fresh budget**: a new id is
 * absent ⇒ 0. This ledger is SEPARATE from `resume-policy.ts`'s `ResumeLedger.priorResumes`,
 * which counts *crash* resumes — the two are never summed (ADR 0152: no double-count).
 */
export interface HealthyResumeLedger {
	/** The healthy subagent instance whose resume is being decided (its spawn / run id). */
	readonly subagentId: string;
	/** How many times THIS instance has already been resumed while healthy (0 on a fresh spawn). */
	readonly cycles: number;
}

/**
 * The action the orchestrator takes for a **healthy** resume request. Exactly two shapes so a
 * caller can `switch` on `.action` with no third "maybe":
 *   - `resume` — resume the SAME subagent; `cycle` is the 1-based index of this resume (the
 *     caller persists it as the instance's new `cycles`).
 *   - `respawn` — do NOT resume the degraded instance; spawn a FRESH one (whose cycle count
 *     starts at 0). Carries WHY (the lifetime cap was reached).
 */
export type HealthyResumeAction =
	| {
			readonly action: "resume";
			readonly subagentId: string;
			/** 1-based index of this healthy resume (`cycles + 1`); ≤ HEALTHY_RESUME_CAP by construction. */
			readonly cycle: number;
			readonly rationale: string;
	  }
	| {
			readonly action: "respawn";
			/** WHY we respawn — the healthy-resume lifetime cap was reached. */
			readonly reason: "cap-reached";
			readonly rationale: string;
	  };

/**
 * Decide whether to resume a **healthy** subagent or replace it with a fresh spawn.
 *
 * The single gate: if this instance has already been resumed `HEALTHY_RESUME_CAP` times
 * (`cycles >= HEALTHY_RESUME_CAP`), RESPAWN — a chain this long correlates with confabulation
 * (ADR 0152 / #1876). Otherwise RESUME, at `cycle = cycles + 1`.
 *
 * Pure and total: every input yields exactly one `resume` or `respawn`, and there is no path
 * from an at-cap instance to a `resume`. It reads ONLY the healthy-resume `cycles` — never a
 * crash count — so it can neither be driven by nor perturb #1751's crash budget (ADR 0152: the
 * two axes stay separate, a resume is never double-counted).
 *
 * `cap` is a parameter (defaulting to `HEALTHY_RESUME_CAP`) purely so the contract is testable
 * at a small bound; production always uses the recorded default.
 */
export const resumeCapDecision = (
	ledger: HealthyResumeLedger,
	cap: number = HEALTHY_RESUME_CAP,
): HealthyResumeAction => {
	// Defensive: a non-positive / non-integer prior count is a corrupt ledger — treat it as a
	// fresh instance (0 resumes so far) rather than trust a bad value into an over/under-count.
	const cycles = Number.isInteger(ledger.cycles) && ledger.cycles > 0 ? ledger.cycles : 0;

	if (cycles >= cap) {
		return {
			action: "respawn",
			reason: "cap-reached",
			rationale:
				`healthy subagent ${ledger.subagentId} has already been resumed ${cycles} time(s) ` +
				`(lifetime cap K=${cap}) — spawn a FRESH instance instead of resuming the degraded one. ` +
				`A long resume chain correlates with confabulation (ADR 0152 mitigation (b) / #1876). ` +
				`Distinct from #1751's crash budget — this counts HEALTHY resume cycles, not crashes.`,
		};
	}

	const cycle = cycles + 1;
	return {
		action: "resume",
		subagentId: ledger.subagentId,
		cycle,
		rationale:
			`healthy subagent ${ledger.subagentId} under the lifetime cap (healthy resume ${cycle}/${cap}) ` +
			`— resume the same instance. (Counts HEALTHY resume cycles only; #1751's crash budget is separate.)`,
	};
};
