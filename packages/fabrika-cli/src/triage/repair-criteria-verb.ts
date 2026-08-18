/**
 * `triage repair-criteria` — repair an acceptance-criteria block's shape, one issue or the board.
 *
 * The counterpart to `review criteria`'s refusal: when the wire read answers `Malformed`, the
 * review gate may neither hand-parse the block nor invent criteria, so a drifted body stalls its PR
 * with no verdict at all. This verb is the one legal recovery, and it repairs exactly what
 * `./repair-criteria.ts` proves mechanical — everything else exits on the group's `14`.
 *
 * The sweep exists because the drift is a standing corpus, not one issue (#5744 measured 279): the
 * same plan runs per open issue, each repair is written and read back individually, and every issue
 * gets an outcome line — a sweep that only named what it changed would make "never looked" and
 * "looked and conforming" one claim.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	getIssue,
	type IssueRecord,
	listOpenIssues,
	patchIssueBody,
	resolveRepo,
} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNREPAIRABLE,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {legacyPreserved} from "./enrich-legacy.ts";
import {type CriteriaRepairPlan, describeRepair, planRepair} from "./repair-criteria.ts";
import {scannedLine} from "./scope.ts";

export interface RepairCriteriaOptions {
	/** The one issue to repair, or `null` with `--sweep` for the whole open board. */
	readonly issue: number | null;
	readonly sweep: boolean;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Shell = ChildProcessSpawner.ChildProcessSpawner;

/**
 * The closed outcome vocabulary a sweep line speaks — one token per plan tag, plus `moved` for an
 * issue whose body changed between the board snapshot and its own write.
 */
const OUTCOME = {
	Repaired: "repaired",
	AlreadyConforming: "conforming",
	NoBlock: "no-block",
	Refused: "refused",
} as const satisfies Record<CriteriaRepairPlan["_tag"], string>;

type SweepOutcome = (typeof OUTCOME)[CriteriaRepairPlan["_tag"]] | "moved";

interface RepairFailure {
	readonly code: number;
	readonly reason: string;
}

/**
 * Patch one planned repair and prove it landed: PATCH, re-read, byte-compare. The same
 * write-then-read-back discipline as `triage enrich`, against the same normalisation.
 */
const writeRepair = (
	repo: string,
	issue: number,
	body: string,
): Effect.Effect<RepairFailure | null, never, Shell> =>
	Effect.gen(function* () {
		const written = yield* patchIssueBody(repo, issue, body);
		if (written._tag === "Failure") {
			return {
				code: WRITE_UNKNOWN,
				reason: `PATCH failed on #${issue}: ${written.reason} — UNKNOWN whether the body changed; re-read it before retrying.`,
			};
		}
		const back = yield* getIssue(repo, issue);
		if (back._tag !== "Present") {
			return {
				code: READBACK_MISMATCH,
				reason: `body written but #${issue} could not be read back (${
					back._tag === "Absent" ? "the issue is now absent" : back.reason
				}) — inspect it before continuing.`,
			};
		}
		if (normalizeForReadback(back.value.body) !== normalizeForReadback(body)) {
			return {
				code: READBACK_MISMATCH,
				reason: `body written but #${issue}'s read-back does not match — inspect it before continuing.`,
			};
		}
		return null;
	});

const runSingle = (
	repo: string,
	issue: number,
	json: boolean,
): Effect.Effect<VerbOutcome, never, Shell> =>
	Effect.gen(function* () {
		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `triage repair-criteria: issue #${issue} not found in ${repo}.`);
		}
		if (target._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`triage repair-criteria: cannot read #${issue} in ${repo}: ${target.reason} — refusing to plan a repair over a body that was never read.`,
			);
		}
		if (target.value.isPullRequest) {
			return refuse(
				ZERO_SCOPE,
				`triage repair-criteria: #${issue} is a pull request — this verb repairs issue bodies only.`,
			);
		}
		if (target.value.state !== "open") {
			return refuse(
				ZERO_SCOPE,
				`triage repair-criteria: #${issue} is ${target.value.state} — only an open issue's contract is graded.`,
			);
		}

		const plan = planRepair(target.value.body, issue, legacyPreserved);
		if (plan._tag === "Refused") {
			return refuse(UNREPAIRABLE, `triage repair-criteria: refused #${issue} — ${plan.reason}`);
		}
		const diagnostics: string[] = [];
		if (plan._tag === "Repaired") {
			diagnostics.push(
				`triage repair-criteria: #${issue} ${plan.repairs.map(describeRepair).join("; ")}, ${plan.criteria.length} criteria intact.`,
			);
			const failure = yield* writeRepair(repo, issue, plan.body);
			if (failure !== null) {
				return refuse(failure.code, `triage repair-criteria: ${failure.reason}`, diagnostics);
			}
		}
		const outcome = OUTCOME[plan._tag];
		return json
			? answer(JSON.stringify({outcome, number: issue}), diagnostics)
			: answer(`${outcome}\t${issue}`, diagnostics);
	});

const runSweep = (repo: string, json: boolean): Effect.Effect<VerbOutcome, never, Shell> =>
	Effect.gen(function* () {
		const board = yield* listOpenIssues(repo);
		if (board._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`triage repair-criteria: the open-issue list could not be read: ${board.reason} — a sweep over an unknown board proves nothing.`,
			);
		}
		const issues: ReadonlyArray<IssueRecord> = [...board.value].sort((a, b) => a.number - b.number);
		const scanned = scannedLine("triage repair-criteria", repo, issues.length, "open issue");

		const lines: string[] = [];
		const rows: Array<{number: number; outcome: SweepOutcome; reason?: string}> = [];
		const counts: Record<SweepOutcome, number> = {
			repaired: 0,
			conforming: 0,
			"no-block": 0,
			refused: 0,
			moved: 0,
		};
		for (const issue of issues) {
			const plan = planRepair(issue.body, issue.number, legacyPreserved);
			let outcome: SweepOutcome = OUTCOME[plan._tag];
			let reason = plan._tag === "Refused" ? plan.reason : null;
			if (plan._tag === "Repaired") {
				// The board snapshot ages across a run of hundreds of sequential writes, and the
				// pipeline edits issue bodies the whole time. Re-read immediately before the PATCH so
				// the planned body is anchored to a body proven live: without this the read-back
				// compares the write against itself and a clobber reads as a success, and GitHub keeps
				// no issue-body history to recover from.
				const fresh = yield* getIssue(repo, issue.number);
				if (fresh._tag === "Unknown") {
					return refuse(
						PRECONDITION_UNKNOWN,
						`triage repair-criteria: cannot re-read #${issue.number} before writing it: ${fresh.reason} — refusing to write a body planned from a snapshot that can no longer be checked.`,
						[scanned, ...lines.map((line) => `triage repair-criteria: before the halt: ${line}`)],
					);
				}
				const stale =
					fresh._tag === "Absent" ||
					normalizeForReadback(fresh.value.body) !== normalizeForReadback(issue.body);
				if (stale) {
					outcome = "moved";
					reason =
						fresh._tag === "Absent"
							? "the issue left the open board mid-sweep"
							: "the body changed after the board snapshot — re-run the sweep to repair it against its current body";
				} else {
					const failure = yield* writeRepair(repo, issue.number, plan.body);
					if (failure !== null) {
						return refuse(failure.code, `triage repair-criteria: ${failure.reason}`, [
							scanned,
							...lines.map((line) => `triage repair-criteria: before the failure: ${line}`),
						]);
					}
				}
			}
			counts[outcome] += 1;
			lines.push(
				reason === null ? `${outcome}\t${issue.number}` : `${outcome}\t${issue.number}\t${reason}`,
			);
			rows.push(
				reason === null ? {number: issue.number, outcome} : {number: issue.number, outcome, reason},
			);
		}

		const summary = `swept\t${counts.repaired}\t${counts.conforming}\t${counts["no-block"]}\t${counts.refused}\t${counts.moved}`;
		return json
			? answer(JSON.stringify({outcome: "swept", scanned: issues.length, counts, issues: rows}), [
					scanned,
				])
			: answer([summary, ...lines].join("\n"), [scanned]);
	});

export const runRepairCriteria = (
	options: RepairCriteriaOptions,
): Effect.Effect<VerbOutcome, never, Shell> =>
	Effect.gen(function* () {
		const {issue, sweep, json} = options;
		if ((issue === null && !sweep) || (issue !== null && sweep)) {
			return refuse(
				FAILED,
				"triage repair-criteria: pass exactly one target — an issue number, or --sweep for the whole open board.",
			);
		}
		if (issue !== null && (!Number.isInteger(issue) || issue <= 0)) {
			return refuse(FAILED, `triage repair-criteria: ${issue} is not an issue number.`);
		}
		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"triage repair-criteria: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;
		return issue !== null ? yield* runSingle(repo, issue, json) : yield* runSweep(repo, json);
	});
