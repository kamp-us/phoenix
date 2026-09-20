/**
 * `review criteria` — the set a review grades: the linked issue's acceptance-criteria block read
 * through the registered `acceptance-criteria` wire format, **plus** every standing ruling on that
 * issue read through the registered `decision-ruling` one.
 *
 * The verb fetches the body and hands it to the format's own `read`; there is **no second parser**
 * (`../wire/acceptance-criteria.ts`, imported). A drifted heading therefore reds as `Malformed`
 * rather than reading as "there were none" — the wire module's discrimination carried to the fetch
 * seam.
 *
 * **The rulings half is why this verb is the gate's whole contract read**, and the defect it closes
 * is told once, in `./graded-set.ts`. The comments are scanned through `../decision/standing-rulings.ts` — the same
 * roster-gated read `decision ruling` answers from, so an off-roster marker is not a ruling here
 * either — and folded with the body in `./graded-set.ts`, which is the only place the two meet.
 *
 * **An unread ruling scan is `11`, never an empty one.** Reporting "no ruling stands" off a roster
 * that did not resolve is exactly the silent-pass this verb exists to close, one layer down.
 *
 * An issue's open/closed state is deliberately not a precondition, asymmetric with
 * `review append-criterion`: reading the contract off a closed issue is a legitimate re-review case,
 * while writing to one buries the row where nobody looks.
 *
 * **A criterion's outside-diff evidence marker rides the same read.** It is the format's own field,
 * so it arrives here parsed rather than as a tail the caller has to recognise in prose, and it is
 * printed beside the criterion it belongs to — the row's last column on stdout, an `evidence` field
 * under `--json`, and a stderr line counting the marked rows so a reviewer scanning diagnostics
 * cannot miss that this contract has any. Those rows are graded on the evidence they name, never on
 * the diff alone (`./outside-diff-evidence.ts`).
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9200
 * @ruling https://github.com/kamp-us/phoenix/issues/9517#issuecomment-5752597880
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {StandingRuling} from "../decision/ruling.ts";
import {standingRulings} from "../decision/standing-rulings.ts";
import {type CommentRecord, getIssue} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readCriteria} from "../wire/acceptance-criteria.ts";
import {rulingComment} from "../wire/decision-ruling.ts";
import {PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {gradedSet, type RulingText, renderGradedSet} from "./graded-set.ts";
import {marked, quoteRows} from "./outside-diff-evidence.ts";
import {badNumber, resolveTargetRepo} from "./target.ts";

const VERB = "review criteria";

export interface CriteriaOptions {
	readonly issue: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The founder's own words behind each marker, taken out of the comment page already in hand.
 *
 * A marker whose cited comment is not on this page carries `null` and the row falls back to its URL
 * — the citation is checked against this issue by the wire format's own read, so the miss is a
 * comment deleted after the ruling rather than a ruling pointing somewhere else.
 */
const withText = (
	rulings: ReadonlyArray<StandingRuling>,
	comments: ReadonlyArray<CommentRecord>,
): ReadonlyArray<RulingText> => {
	const byId = new Map(comments.map((comment) => [comment.id, comment.body]));
	return rulings.map((ruling) => ({
		ruling,
		text: byId.get(rulingComment(ruling.ruling.ruling)) ?? null,
	}));
};

export const runCriteria = (
	options: CriteriaOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, json} = options;
		const bad = badNumber(VERB, "an issue number", issue);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const found = yield* getIssue(repo, issue);
		if (found._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: issue #${issue} not found in ${repo}.`);
		}
		if (found._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${issue} in ${repo}: ${found.reason} — whether a block exists is UNKNOWN.`,
			);
		}

		const diagnostics =
			found.value.state === "open"
				? []
				: [`${VERB}: #${issue} is ${found.value.state} — reading its contract anyway.`];

		const block = readCriteria(found.value.body);
		if (block._tag === "Absent") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${issue} carries no acceptance-criteria block — absent: ${block.reason}. Grade nothing; the contract is missing.`,
				diagnostics,
			);
		}
		if (block._tag === "Malformed") {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${issue}'s acceptance-criteria block is malformed: ${block.reason} — a drifted heading is a defect to report, not "there were none".`,
				diagnostics,
			);
		}

		const ruled = yield* standingRulings(repo, issue);
		if (ruled._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${ruled.reason} — the graded set is UNKNOWN, never the body alone.`,
				diagnostics,
			);
		}

		const criteria = block.value;
		const set = gradedSet(criteria, withText(ruled.scan.all, ruled.comments));
		diagnostics.push(
			ruled.roster === null
				? `${VERB}: read ${ruled.comments.length} comment(s) on #${issue}; none reaches for a ruling marker, so the control-plane roster was not resolved.`
				: `${VERB}: ${ruled.roster.size} control-plane account(s) from ${ruled.roster.owners} at ${ruled.roster.ref}; read ${ruled.comments.length} comment(s) on #${issue}.`,
			`${VERB}: the graded set is ${criteria.length} body criteri${criteria.length === 1 ? "on" : "a"} plus ${set.rulings} standing ruling(s); ${set.superseded} body row(s) superseded, ${ruled.scan.disregarded} drifted marker(s) disregarded, ${ruled.scan.unauthorized} from an account off that roster.`,
		);
		if (set.rulings > 0) {
			diagnostics.push(
				`${VERB}: grade the ruling rows as well as the body rows — where the two contradict, the newest ruling is the spec and a superseded body row is reported, not graded.`,
			);
		}
		for (const position of set.danglingSupersedes) {
			diagnostics.push(
				`${VERB}: a ruling names supersedes:${position} and #${issue}'s block has ${criteria.length} row(s) — the marker outlived the row it replaced; report it rather than grading around it.`,
			);
		}

		const markedRows = marked(criteria);
		if (markedRows.length > 0) {
			diagnostics.push(
				`${VERB}: ${markedRows.length} of ${criteria.length} criteria mark evidence outside the diff — grade each on the evidence it names, and name it in the verdict body:`,
				quoteRows(markedRows),
			);
		}
		return json
			? answer(
					JSON.stringify({
						outcome: "criteria",
						issue,
						count: criteria.length,
						marked: markedRows.length,
						rulings: set.rulings,
						superseded: set.superseded,
						disregarded: ruled.scan.disregarded,
						unauthorized: ruled.scan.unauthorized,
						danglingSupersedes: set.danglingSupersedes,
						criteria: set.rows,
					}),
					diagnostics,
				)
			: answer(
					[`criteria\t${criteria.length}`, `rulings\t${set.rulings}`, ...renderGradedSet(set)].join(
						"\n",
					),
					diagnostics,
				);
	});
