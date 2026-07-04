/**
 * `drive-issue` stage-boundary guard — the pure, IO-free mirror of the workflow's
 * `stageResult` / `StageAborted` seam (issue #1692). `agent()` resolves to `null` on a
 * documented, EXPECTED outcome: a subagent that dies on a terminal error (a harness
 * session limit) or is skipped by the user. Dereferencing that `null` at any stage
 * boundary (`verdict.verdict`, `built.pr`, …) crashed the whole run with an uncaught
 * `TypeError`; instead every boundary routes its `agent()` result through this guard,
 * which throws `StageAborted` on a `null`/non-object result. The workflow's top-level
 * catch converts that into a structured, resumable `{ aborted, stage, pr? }` return.
 *
 * The workflow inlines the identical guard (top-level `return` + injected globals ⇒ the
 * script is not importable); this module is its canonical mirror and the one that carries
 * the unit test, so the null-abort contract is verifiable without spawning real agents
 * (the `trivial-diff/route.ts` sibling shape).
 */

/** Thrown by {@link stageResult} when an `agent()` stage returned a null/non-object result. */
export class StageAborted extends Error {
	readonly stage: string;
	readonly pr: number | undefined;
	constructor(stage: string, pr?: number) {
		super(
			`drive-issue: ${stage} stage returned a null result (dead or skipped subagent) — aborting cleanly`,
		);
		this.name = "StageAborted";
		this.stage = stage;
		this.pr = pr;
	}
}

/**
 * The ONLY sanctioned way to consume an `agent()` result. Returns a non-null object result
 * unchanged; throws {@link StageAborted} (caught at the workflow top level → a structured
 * `{ aborted }` return) when `agent()` returned `null`/`undefined` or a non-object (a
 * dead/skipped subagent). Gate EVERY `agent()`-result field read on this — never deref a
 * raw `agent()` return.
 *
 * The parameter is `unknown` on purpose: an `agent()` result is untyped at the runtime
 * boundary (a dead/skipped subagent yields `null`; a scalar is possible), so this guard
 * narrows it — the caller then reads fields off the returned object under `T`.
 */
export const stageResult = <T extends object>(stage: string, result: unknown, pr?: number): T => {
	if (result == null || typeof result !== "object") {
		throw new StageAborted(stage, pr);
	}
	return result as T;
};
