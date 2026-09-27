/**
 * An epic child's integrate `FAIL` — which exit the merge refused on and which assembly head it
 * refused against — as the one record a repair builder can key on.
 *
 * `lane integrate` judges the merged tree, and three of its exits are a `FAIL` the child region
 * sends back to `build` under the retry budget: `42` with no replay attempted, `43` and `44`. None
 * of them writes a verdict on the child, so the range verdicts a child's `build claim` reads stay
 * `PASS` and the claim had no way to tell a repair round from a finished child — the repair the
 * machine routed to could not be taken by any builder. The ledger line that records the `FAIL` is
 * the record, so it carries this evidence and `build claim` reads it back.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9761
 */
import {bareEvent} from "./machine.ts";

/** The child region's cell whose `FAIL` this evidence rides — `emit.ts`'s `integrate`. */
export const INTEGRATE_STATE = "integrate";

/** `lane integrate`'s three `FAIL` exits — the operate skill's integrate table, and no other code. */
export const INTEGRATE_FAIL_EXITS = [42, 43, 44] as const;
export type IntegrateFailExit = (typeof INTEGRATE_FAIL_EXITS)[number];

export interface IntegrateFailure {
	readonly exit: IntegrateFailExit;
	/** The assembly branch's head the merge was refused against, which the verb reset it back to. */
	readonly head: string;
}

const SHA = /^[0-9a-f]{7,40}$/;

const isFailExit = (value: unknown): value is IntegrateFailExit =>
	INTEGRATE_FAIL_EXITS.some((code) => code === value);

/** Whether a parsed ledger field is the shape {@link IntegrateFailure} names, and nothing looser. */
export const isIntegrateFailure = (value: unknown): value is IntegrateFailure => {
	if (typeof value !== "object" || value === null) return false;
	const {exit, head} = value as {exit?: unknown; head?: unknown};
	return isFailExit(exit) && typeof head === "string" && SHA.test(head);
};

export type IntegrateEvidenceRead =
	| {readonly _tag: "None"}
	| {readonly _tag: "Read"; readonly failure: IntegrateFailure}
	| {readonly _tag: "Rejected"; readonly reason: string};

/**
 * Read the two flags as one value: both or neither. An exit without the head it failed against, or
 * a head without the exit, tells a repair builder half of what it is fixing.
 */
export const readIntegrateEvidence = (
	exit: number | null,
	head: string | null,
): IntegrateEvidenceRead => {
	if (exit === null && head === null) return {_tag: "None"};
	if (exit === null || head === null) {
		return {
			_tag: "Rejected",
			reason: `--integrate-exit and --assembly-head are one record — pass both or neither`,
		};
	}
	if (!isFailExit(exit)) {
		return {
			_tag: "Rejected",
			reason: `--integrate-exit ${exit} is not one of lane integrate's FAIL exits (${INTEGRATE_FAIL_EXITS.join(", ")})`,
		};
	}
	const sha = head.trim().toLowerCase();
	if (!SHA.test(sha)) {
		return {
			_tag: "Rejected",
			reason: `--assembly-head "${head}" is not a commit sha (7 to 40 hex characters)`,
		};
	}
	return {_tag: "Read", failure: {exit, head: sha}};
};

/**
 * Whether this evidence may ride this event out of this cell: required on a `FAIL` out of
 * `integrate`, refused everywhere else. `null` is the answer that admits the record.
 */
export const integrateEvidenceRefusal = (
	leaf: string,
	event: string,
	evidence: IntegrateFailure | null,
): string | null => {
	const integrateFail = leaf === INTEGRATE_STATE && event === "FAIL";
	if (integrateFail && evidence === null) {
		return `a FAIL out of "${INTEGRATE_STATE}" names the lane integrate exit and the assembly head it failed against — pass --integrate-exit <${INTEGRATE_FAIL_EXITS.join("|")}> --assembly-head <sha>, which is the only record a repair builder can key on`;
	}
	if (!integrateFail && evidence !== null) {
		return `--integrate-exit and --assembly-head ride a FAIL out of "${INTEGRATE_STATE}" only, and this is a ${event} out of "${leaf === "" ? "no state" : leaf}"`;
	}
	return null;
};

interface TaskLine {
	readonly task: string;
	readonly event: string;
	readonly integrate?: IntegrateFailure;
}

/**
 * The integrate `FAIL` still standing over one task, or `null`.
 *
 * The latest line carrying integrate evidence stands until the task records a `DONE`: the repair
 * builder's own `DONE` out of `build` answers it, and so does a later clean integrate's `DONE`. A
 * park or a lap between the two retires nothing — the repair is still owed.
 */
export const standingIntegrateFailure = (
	entries: ReadonlyArray<TaskLine>,
	task: string,
): IntegrateFailure | null => {
	let standing: IntegrateFailure | null = null;
	for (const entry of entries) {
		if (entry.task !== task) continue;
		if (entry.integrate !== undefined) standing = entry.integrate;
		else if (bareEvent(entry.event) === "DONE") standing = null;
	}
	return standing;
};
