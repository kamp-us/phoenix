/**
 * `triage sweep-homes` — the apply side of `guard homing-guard check`: clear the milestone on every
 * double-marked triaged issue, keep its standing lane, and leave one trail comment on it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/7393#issuecomment-5519748588
 *
 * The scan is the guard's own: the same paged `status:triaged` read and the same record mapping, so
 * the plan in `./sweep-homes.ts` is judged over the set the guard judges.
 *
 * **A dry run is the default.** Writes happen only under `--apply`, and only there is the trail
 * citation read from stdin.
 *
 * **Per issue, the trail lands before the clear.** The issue is re-read first and skipped as `moved`
 * when the breach it was planned from is gone. Its comments are read reconciled against the count the
 * issue declares, so a trail this verb posted moments earlier cannot be missed by a short list, and
 * the trail is posted unless one carrying this milestone's marker is already there. Then the milestone is cleared and read back.
 * That order lets a run that died between the two writes be re-run: the breach is still on the
 * board, and the trail is found rather than posted twice.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {TRIAGED_LABEL, UNHOMED_REMEDY} from "../guard/homing.ts";
import {toTriaged} from "../guard/homing-verb.ts";
import {
	clearMilestone,
	createComment,
	getIssue,
	listCommentsReconciled,
	openIssuesWithLabelRecords,
	resolveRepo,
} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNHOMED_REMAIN,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {scannedLine} from "./scope.ts";
import {
	type DoubleMarked,
	hasTrail,
	landedExempt,
	planSweep,
	stillDoubleMarked,
	trailComment,
	type Unhomed,
} from "./sweep-homes.ts";

const VERB = "triage sweep-homes";

const SURFACE: AuthoredSurface = {
	verb: VERB,
	noun: "the trail citation",
	emptyHint:
		"every cleared issue gets a trail comment, so pipe in the decision and ruling it cites.",
};

/** A dry run plans and writes nothing; only an explicit apply writes. */
export type SweepMode = "dry-run" | "apply";

export interface SweepHomesOptions {
	readonly mode: SweepMode;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Read only under `apply`: the citation every trail comment carries. */
	readonly stdin: Effect.Effect<StdinRead>;
}

type Shell = ChildProcessSpawner.ChildProcessSpawner;

/** One double-marked issue's outcome. `would-clear` is a dry run's, never an apply's. */
type Row =
	| {readonly outcome: "would-clear"; readonly breach: DoubleMarked}
	| {readonly outcome: "cleared"; readonly breach: DoubleMarked; readonly trail: string}
	| {readonly outcome: "moved"; readonly breach: DoubleMarked; readonly reason: string};

const rowLine = (row: Row): string => {
	const {number, milestone, lanes} = row.breach;
	const head = `${row.outcome}\t${number}\t${milestone}\t${lanes.join(",")}`;
	switch (row.outcome) {
		case "would-clear":
			return head;
		case "cleared":
			return `${head}\t${row.trail}`;
		case "moved":
			return `${head}\t${row.reason}`;
	}
};

const unhomedLine = (issue: Unhomed): string => `unhomed\t${issue.number}\t${issue.title}`;

/** Why one clear stopped the sweep. Every later issue is left unread and unwritten. */
interface Halt {
	readonly code: number;
	readonly reason: string;
}

/**
 * Re-read, trail, clear and read back one double-marked issue. Answers the row, or the halt that
 * stops the sweep; a halt names what is on the board and what a re-run does about it.
 */
const sweepOne = (
	repo: string,
	breach: DoubleMarked,
	trail: string,
): Effect.Effect<Row | Halt, never, Shell> =>
	Effect.gen(function* () {
		const n = breach.number;
		const fresh = yield* getIssue(repo, n);
		if (fresh._tag === "Unknown") {
			return {
				code: PRECONDITION_UNKNOWN,
				reason: `cannot re-read #${n} before writing it: ${fresh.reason} — nothing was written to #${n}.`,
			};
		}
		if (fresh._tag === "Absent" || fresh.value.state !== "open") {
			return {outcome: "moved", breach, reason: "the issue left the open board mid-sweep"};
		}
		if (!stillDoubleMarked(toTriaged(fresh.value), breach)) {
			return {
				outcome: "moved",
				breach,
				reason: "the milestone or lane changed after the board read — re-run to judge it again",
			};
		}

		const comments = yield* listCommentsReconciled(repo, n);
		if (comments._tag === "Failure") {
			return {
				code: PRECONDITION_UNKNOWN,
				reason: `cannot read #${n}'s comments to find an earlier trail: ${comments.reason} — nothing was written to #${n}.`,
			};
		}
		let trailUrl = "trail-existing";
		if (
			!hasTrail(
				comments.value.comments.map((comment) => comment.body),
				breach.milestone,
			)
		) {
			const posted = yield* createComment(repo, n, trail);
			if (posted._tag === "Failure") {
				return {
					code: WRITE_UNKNOWN,
					reason: `the trail comment on #${n} failed: ${posted.reason} — its milestone is untouched; re-run, and a trail that did land is found rather than posted twice.`,
				};
			}
			trailUrl = posted.value.url;
		}

		const cleared = yield* clearMilestone(repo, n);
		if (cleared._tag === "Failure") {
			return {
				code: WRITE_UNKNOWN,
				reason: `#${n} carries its trail, but clearing milestone ${breach.milestone} failed: ${cleared.reason} — UNKNOWN whether it cleared; re-run, which finds the trail and posts no second one.`,
			};
		}
		const back = yield* getIssue(repo, n);
		if (back._tag !== "Present") {
			return {
				code: READBACK_MISMATCH,
				reason: `milestone ${breach.milestone} was cleared on #${n}, but #${n} could not be read back (${
					back._tag === "Absent" ? "it is now absent" : back.reason
				}) — inspect it before continuing.`,
			};
		}
		if (!landedExempt(toTriaged(back.value), breach)) {
			return {
				code: READBACK_MISMATCH,
				reason: `#${n}'s read-back is not milestone-less with ${breach.lanes.join(", ")} kept — inspect it before continuing.`,
			};
		}
		return {outcome: "cleared", breach, trail: trailUrl};
	});

const isHalt = (step: Row | Halt): step is Halt => "code" in step;

export const runSweepHomes = (
	options: SweepHomesOptions,
): Effect.Effect<VerbOutcome, never, Shell> =>
	Effect.gen(function* () {
		const {mode, json} = options;
		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.`,
			);
		}
		const repo = repoAttempt.value;

		let citation = "";
		if (mode === "apply") {
			const authored = readAuthored(SURFACE, yield* options.stdin);
			if (authored._tag === "Refused") return authored.outcome;
			citation = authored.text;
		}

		const read = yield* openIssuesWithLabelRecords(repo, TRIAGED_LABEL);
		if (read._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the open ${TRIAGED_LABEL} set in ${repo}: ${read.reason} — nothing was written; the sweep is UNKNOWN, never clean.`,
			);
		}
		const scanned = scannedLine(VERB, repo, read.value.length, `open ${TRIAGED_LABEL} issue`);
		const plan = planSweep(read.value.map(toTriaged));
		if (plan._tag === "ZeroScope") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: the open ${TRIAGED_LABEL} set in ${repo} is empty — an empty backlog cannot be told from a broken read, so nothing was swept and nothing is reported clean.`,
				[scanned],
			);
		}
		const tally = `${VERB}: ${plan.clears.length} double-marked, ${plan.unhomed.length} un-homed, ${plan.homed} homed, ${plan.exempt} exempt.`;

		// Every trail is composed and leak-scanned before the first write, so a citation carrying a
		// machine-local path refuses the whole sweep rather than halting it halfway.
		const trails = plan.clears.map((breach) => trailComment(breach, citation));
		if (mode === "apply") {
			for (const trail of trails) {
				const leaked = leakRefusal(SURFACE, trail);
				if (leaked !== null) return leaked;
			}
		}

		const rows: Row[] = [];
		for (const [index, breach] of plan.clears.entries()) {
			if (mode === "dry-run") {
				rows.push({outcome: "would-clear", breach});
				continue;
			}
			const step = yield* sweepOne(repo, breach, trails[index] ?? "");
			if (isHalt(step)) {
				return refuse(step.code, `${VERB}: ${step.reason}`, [
					scanned,
					tally,
					...rows.map((row) => `${VERB}: before the halt: ${rowLine(row)}`),
				]);
			}
			rows.push(step);
		}

		const lines = rows.map(rowLine);
		if (plan.unhomed.length > 0) {
			return refuse(
				UNHOMED_REMAIN,
				`${VERB}: ${plan.unhomed.length} un-homed issue(s) left untouched — choosing a home is triage's call, not this sweep's.\n${UNHOMED_REMEDY}`,
				[scanned, tally, ...lines, ...plan.unhomed.map(unhomedLine)],
			);
		}

		const count = (outcome: Row["outcome"]) => rows.filter((row) => row.outcome === outcome).length;
		const header =
			mode === "dry-run"
				? `planned\t${count("would-clear")}`
				: `swept\t${count("cleared")}\t${count("moved")}`;
		if (json) {
			return answer(
				JSON.stringify({
					outcome: mode === "dry-run" ? "planned" : "swept",
					scanned: plan.scanned,
					issues: rows.map((row) => ({
						outcome: row.outcome,
						number: row.breach.number,
						milestone: row.breach.milestone,
						lanes: row.breach.lanes,
						...(row.outcome === "cleared" ? {trail: row.trail} : {}),
						...(row.outcome === "moved" ? {reason: row.reason} : {}),
					})),
				}),
				[scanned, tally],
			);
		}
		return answer([header, ...lines].join("\n"), [scanned, tally]);
	});
