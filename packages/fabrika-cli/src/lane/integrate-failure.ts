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
 * A red validator that is red on the pre-merge head too is no `FAIL` at all: it is the base's, and it
 * is recorded as a lap that carries {@link BaseRedEvidence} instead.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9761
 * @ruling https://github.com/kamp-us/phoenix/issues/10257#issuecomment-5974130674
 */
import {ASSEMBLY_BASE_RED} from "./codes.ts";
import {type IntegrateRedRecord, isRedRun, latestRedRecord, type RedRun} from "./integrate-red.ts";
import {bareEvent} from "./machine.ts";

/** The child region's cell whose `FAIL` this evidence rides — `emit.ts`'s `integrate`. */
export const INTEGRATE_STATE = "integrate";

/** `lane integrate`'s three `FAIL` exits — the operate skill's integrate table, and no other code. */
export const INTEGRATE_FAIL_EXITS = [42, 43, 44] as const;
export type IntegrateFailExit = (typeof INTEGRATE_FAIL_EXITS)[number];

/**
 * One integrate `FAIL`'s evidence. `head` is the assembly branch's head the merge was refused
 * against, which the verb reset it back to. A `44` also names the validator that went red and keeps
 * its output, copied off integrate's own record ([`integrate-red.ts`](integrate-red.ts)), so the
 * repair builder reads what failed without re-running it. A `44` recorded before that record existed
 * carries none, and neither does a `42` or a `43`.
 */
export type IntegrateFailure =
	| {readonly exit: 42 | 43; readonly head: string}
	| {readonly exit: 44; readonly head: string; readonly red?: RedRun};

/** The park cause a red base's lap carries — `report.ts`'s `PARK_CAUSES` holds its entry. */
export const BASE_RED_CAUSE = "assembly-base-red";

/**
 * A red base's evidence, on the lap (or the park past its cap) that records it: the pre-merge
 * assembly head the failed validator was re-run over, and what that re-run printed.
 */
export interface BaseRedEvidence {
	readonly head: string;
	readonly red: RedRun;
}

const SHA = /^[0-9a-f]{7,40}$/;

const isFailExit = (value: unknown): value is IntegrateFailExit =>
	INTEGRATE_FAIL_EXITS.some((code) => code === value);

/** Whether a parsed ledger field is the shape {@link IntegrateFailure} names, and nothing looser. */
export const isIntegrateFailure = (value: unknown): value is IntegrateFailure => {
	if (typeof value !== "object" || value === null) return false;
	const {exit, head, red} = value as {exit?: unknown; head?: unknown; red?: unknown};
	if (!isFailExit(exit) || typeof head !== "string" || !SHA.test(head)) return false;
	return red === undefined || (exit === 44 && isRedRun(red));
};

/** Whether a parsed ledger field is the shape {@link BaseRedEvidence} names. */
export const isBaseRedEvidence = (value: unknown): value is BaseRedEvidence => {
	if (typeof value !== "object" || value === null) return false;
	const {head, red} = value as {head?: unknown; red?: unknown};
	return typeof head === "string" && SHA.test(head) && isRedRun(red);
};

export type IntegrateEvidenceRead =
	| {readonly _tag: "None"}
	| {readonly _tag: "Read"; readonly failure: IntegrateFailure}
	| {readonly _tag: "Rejected"; readonly reason: string};

type PairRead =
	| {readonly _tag: "None"}
	| {readonly _tag: "Read"; readonly exit: number; readonly head: string}
	| {readonly _tag: "Rejected"; readonly reason: string};

const readPair = (exit: number | null, head: string | null): PairRead => {
	if (exit === null && head === null) return {_tag: "None"};
	if (exit === null || head === null) {
		return {
			_tag: "Rejected",
			reason: `--integrate-exit and --assembly-head are one record — pass both or neither`,
		};
	}
	const sha = head.trim().toLowerCase();
	if (!SHA.test(sha)) {
		return {
			_tag: "Rejected",
			reason: `--assembly-head "${head}" is not a commit sha (7 to 40 hex characters)`,
		};
	}
	return {_tag: "Read", exit, head: sha};
};

const notAFailExit = (exit: number): string =>
	`--integrate-exit ${exit} is not one of lane integrate's FAIL exits (${INTEGRATE_FAIL_EXITS.join(", ")})`;

/**
 * Read the two flags as one value: both or neither. An exit without the head it failed against, or
 * a head without the exit, tells a repair builder half of what it is fixing.
 */
export const readIntegrateEvidence = (
	exit: number | null,
	head: string | null,
): IntegrateEvidenceRead => {
	const pair = readPair(exit, head);
	if (pair._tag !== "Read") return pair;
	if (!isFailExit(pair.exit)) return {_tag: "Rejected", reason: notAFailExit(pair.exit)};
	return {_tag: "Read", failure: {exit: pair.exit, head: pair.head}};
};

/**
 * What `lane report`'s pair names: an integrate `FAIL`, or a red base (`lane integrate`'s exit
 * {@link ASSEMBLY_BASE_RED}). Neither is a line's evidence yet: a `44` and a red base are both
 * resolved against integrate's own record by {@link resolveIntegrateClaim} before anything lands.
 */
export type IntegrateClaim =
	| {readonly _tag: "Fail"; readonly failure: IntegrateFailure}
	| {readonly _tag: "BaseRed"; readonly head: string};

export type IntegrateClaimRead =
	| {readonly _tag: "None"}
	| {readonly _tag: "Read"; readonly claim: IntegrateClaim}
	| {readonly _tag: "Rejected"; readonly reason: string};

/** {@link readIntegrateEvidence}, plus the red base's exit, which only `lane report` takes. */
export const readIntegrateClaim = (
	exit: number | null,
	head: string | null,
): IntegrateClaimRead => {
	const pair = readPair(exit, head);
	if (pair._tag !== "Read") return pair;
	if (pair.exit === ASSEMBLY_BASE_RED) {
		return {_tag: "Read", claim: {_tag: "BaseRed", head: pair.head}};
	}
	if (!isFailExit(pair.exit)) {
		return {
			_tag: "Rejected",
			reason: `${notAFailExit(pair.exit)}, nor its red-base exit ${ASSEMBLY_BASE_RED}`,
		};
	}
	return {_tag: "Read", claim: {_tag: "Fail", failure: {exit: pair.exit, head: pair.head}}};
};

/**
 * Whether this pair may ride this event out of this cell. `null` is the answer that admits it.
 *
 * Two kinds of line need one and no other line takes one: a `FAIL` out of `integrate` names a `FAIL`
 * exit, and a line caused {@link BASE_RED_CAUSE} — the lap, or the park past its cap — names the
 * red-base exit. Neither the cause alone nor the exit alone reaches the second.
 */
export const integrateEvidenceRefusal = (
	leaf: string,
	event: string,
	cause: string | null,
	claim: IntegrateClaim | null,
): string | null => {
	const where = `a ${event} out of "${leaf === "" ? "no state" : leaf}"`;
	if (cause === BASE_RED_CAUSE) {
		if (leaf !== INTEGRATE_STATE) {
			return `--cause ${BASE_RED_CAUSE} names a red base lane integrate proved, so it is recorded out of "${INTEGRATE_STATE}" only, and this is ${where}`;
		}
		return claim?._tag === "BaseRed"
			? null
			: `a ${BASE_RED_CAUSE} line names the assembly head lane integrate re-ran the failed validator over — pass --integrate-exit ${ASSEMBLY_BASE_RED} --assembly-head <sha>, the exit and head integrate printed`;
	}
	if (leaf === INTEGRATE_STATE && event === "FAIL") {
		if (claim === null) {
			return `a FAIL out of "${INTEGRATE_STATE}" names the lane integrate exit and the assembly head it failed against — pass --integrate-exit <${INTEGRATE_FAIL_EXITS.join("|")}> --assembly-head <sha>, which is the only record a repair builder can key on`;
		}
		return claim._tag === "BaseRed"
			? `lane integrate exit ${ASSEMBLY_BASE_RED} is a red base, which is machinery and never the child's FAIL — record the BASE-RED lap instead`
			: null;
	}
	if (claim === null) return null;
	return claim._tag === "BaseRed"
		? `--integrate-exit ${ASSEMBLY_BASE_RED} rides the BASE-RED lap out of "${INTEGRATE_STATE}" only, and this is ${where}`
		: `--integrate-exit and --assembly-head ride a FAIL out of "${INTEGRATE_STATE}" only, and this is ${where}`;
};

/** What a pair resolves to against integrate's record: the evidence to land, or why it may not. */
export type ResolvedClaim =
	| {readonly _tag: "Failure"; readonly failure: IntegrateFailure}
	| {readonly _tag: "BaseRed"; readonly baseRed: BaseRedEvidence}
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * Take a `44` or a red base off the record `lane integrate` wrote, never off the caller's word.
 *
 * Only the record says what the re-run over the pre-merge head found, so it is what picks between the
 * two: a base that came back green makes the red the child's, and a base that came back red makes it
 * machinery. A `44` without a record is refused rather than landed bare, because a bare `44` is
 * exactly the charge a red base must never take. A `42` or a `43` reads no record — integrate runs no
 * validator on either.
 */
export const resolveIntegrateClaim = (
	claim: IntegrateClaim,
	records: ReadonlyArray<IntegrateRedRecord>,
	child: number | null,
): ResolvedClaim => {
	if (claim._tag === "Fail" && claim.failure.exit !== 44) {
		return {_tag: "Failure", failure: claim.failure};
	}
	const head = claim._tag === "Fail" ? claim.failure.head : claim.head;
	if (child === null) {
		return {
			_tag: "Refused",
			reason: `lane integrate's validator record is keyed on an epic child's issue, and this task names none`,
		};
	}
	const record = latestRedRecord(records, head, child);
	if (record === null) {
		return {
			_tag: "Refused",
			reason: `lane integrate wrote no red-validator record for #${child} against assembly head ${head} — run lane integrate, and record the exit and head it printed`,
		};
	}
	if (claim._tag === "Fail") {
		return record.base.verdict === "red"
			? {
					_tag: "Refused",
					reason: `lane integrate re-ran ${record.merged.validator} over assembly head ${head} and it was red there too — that is a red base, never the child's FAIL; record BASE-RED with --integrate-exit ${ASSEMBLY_BASE_RED}`,
				}
			: {_tag: "Failure", failure: {exit: 44, head, red: record.merged}};
	}
	return record.base.verdict === "red"
		? {
				_tag: "BaseRed",
				baseRed: {head, red: {validator: record.merged.validator, output: record.base.output}},
			}
		: {
				_tag: "Refused",
				reason: `lane integrate re-ran ${record.merged.validator} over assembly head ${head} and it was green there — the red is the child's, so record FAIL --integrate-exit 44`,
			};
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
