/**
 * `decision rule` — record a control-plane human's ruling on one issue, and hand a parked decision
 * back to the agent lane.
 *
 * **The subject is any issue, and that is the newer half.** A founder ruling lands wherever the work
 * is, and recorded as prose it changed nothing about what any gate graded — the defect
 * `../review/graded-set.ts` tells. Recorded through this verb it is a marker `review criteria` folds
 * into the graded set and `lane prove` dates a verdict against.
 * `--supersedes <k>` is how the ruling says which body criterion it replaces — the only mechanical
 * statement of contradiction there is, because no verb can read the prose and judge that itself.
 *
 * **The audience flip did not widen with the subject, and the `type:decision` read below is what
 * holds it back.** `audienceWrites` is unconditional in both directions, so a widened flip would
 * strip `ready-for:human` off any parked bug that happens to carry a criteria block — recording a
 * ruling would make a human-parked issue agent-pickable, and `build claim`'s audience axis is the
 * fence that would stop firing. Off the decision path this verb writes the marker and leaves both
 * audience labels exactly as it found them.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9517#issuecomment-5752597880
 *
 * The gap this closes: triage routes a decision to `ready-for:human` because its deliverable is a
 * judgement, and once the founder has made that judgement in a comment there is no path back. The
 * label still says "a human must decide" about a question a human decided, so every ruled decision
 * costs a driver bypass around the park.
 *
 * **The digest is derived here and taken from nowhere.** There is no `--digest` flag, and adding one
 * would be the defect: a ruling whose scope its caller supplies attests whatever the caller pleased,
 * which is precisely the binding the marker exists to be. The verb reads the issue and takes
 * `./digest.ts`'s answer over the body it actually read.
 *
 * **The order of the two writes is the invariant.** The marker is posted and read back *first*, and
 * only a proven marker earns the audience flip. Reversed, a failed marker write would leave an issue
 * reading `ready-for:agent` with no recorded ruling behind it — a decision that looks pickable
 * because of an authority nobody can point at, which is the exact failure this verb exists to close.
 *
 * A roster that could not be read is `11` — never "not authorized" and never "authorized". That is
 * the collapse `ship cp-approval` already refuses to make, and it is worth more here: this
 * verb's whole output is an authority claim.
 *
 * **The guard sits on the flip, never on the ruling.** A ruled decision whose body carries no
 * acceptance-criteria block still earns its marker — the founder's judgement is the durable thing —
 * but not the audience, because `ready-for:agent` promises a builder can grade the issue cold and a
 * criteria-less one only parks the lane at `build claim` exit 32.
 *
 * **Two shapes name the ruling, and exactly one is given.** `--cites` names a comment that is
 * already on the issue; `--authorization` hands over a file quoting the founder's words, which this
 * verb posts verbatim and then cites — `grill rule`'s shape, through the same check in
 * `../authorization.ts`, so a ruling given in conversation costs the founder no comment to type. The
 * two write orders mirror each other: under `--authorization` the quote lands FIRST and the marker
 * second, because an interrupted run that wrote the marker first would leave it pointing at a
 * comment that does not exist, while the reverse leaves a dated quote nothing honours.
 *
 * **What the authorization shape changes about the authority, and what it does not.** The account
 * invoking this verb still has to be on the control-plane roster, and the comment it posts is that
 * account's; nothing is loosened at the ACL. What moves is who types the words: an agent relaying a
 * founder ruling verbatim is recording it, not making it, and no machine can tell a truthful relay
 * from a fabricated one. That is the same limit `grill rule` states, taken knowingly.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8857#issuecomment-5625302485
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	type AuthorizationDocument,
	authorizationBody,
	readAuthorization,
} from "../authorization.ts";
import {DECISION_TYPE_LABEL, parseCitation} from "../build/scope-admission.ts";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {
	addLabels,
	createComment,
	getComment,
	getIssue,
	listComments,
	listLabels,
	removeLabel,
} from "../io/issues.ts";
import {viewerLogin} from "../io/pulls.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {controlPlaneRoster} from "../ship/roster.ts";
import {
	audienceSettled,
	audienceWrites,
	READY_FOR_AGENT,
	READY_FOR_HUMAN,
} from "../triage/audience.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type AcceptanceCriteriaRead, read as readCriteria} from "../wire/acceptance-criteria.ts";
import {
	type CriterionIndex,
	criterionIndex,
	emit,
	markedIssue,
	RULING_GRAMMAR,
	type RulingUrl,
	rulingUrl,
	scopeDigest,
} from "../wire/decision-ruling.ts";
import {stampOf} from "../wire/grill-marker.ts";
import {
	AUTHORIZATION_ABSENT,
	BARE_AT_PATH,
	CRITERIA_REQUIRED,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	RULING_UNAUTHORIZED,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {requireRulable} from "./ruling.ts";

const VERB = "decision rule";

/** The seats this group gives the shared authorization check's three proven refusals. */
const AUTHORIZATION_CODES = {
	absent: AUTHORIZATION_ABSENT,
	bareAt: BARE_AT_PATH,
	leaked: LEAKED_PATH,
};

/**
 * A comment's URL in the one grammar the marker reads, composed from the ids rather than taken off
 * the create call's `html_url` echo — the marker's own read checks this shape, so composing it here
 * is what makes the write and the read agree without a second parser.
 */
const commentUrl = (repo: string, issue: number, id: number): string =>
	`https://github.com/${repo}/issues/${issue}#issuecomment-${id}`;

type CitedRuling =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Cited"; readonly url: RulingUrl; readonly commentId: number};

/** The `--cites` shape's two reads: the citation grammar, and the brand the marker's field needs. */
const citedRuling = (cites: string, repo: string, issue: number): CitedRuling => {
	const read = parseCitation(cites, repo, issue);
	if (read._tag === "Malformed") {
		return {
			_tag: "Refused",
			outcome: refuse(FAILED, `${VERB}: --cites ${read.reason}; nothing was written.`),
		};
	}
	const url = rulingUrl(cites);
	if (url === null || read.citation._tag !== "Cited") {
		return {
			_tag: "Refused",
			outcome: refuse(
				FAILED,
				`${VERB}: --cites "${cites}" is not an issue-comment URL — the grammar is ${RULING_GRAMMAR}; nothing was written.`,
			),
		};
	}
	return {_tag: "Cited", url, commentId: read.citation.commentId};
};

/** Whether the ruled issue is the one type whose audience this verb may move. */
export const onDecisionPath = (labels: ReadonlyArray<string>): boolean =>
	labels.includes(DECISION_TYPE_LABEL);

/**
 * The label writes this run owes, which only a `type:decision` is ever owed.
 *
 * Two conditions, and neither is redundant. The type read is the fence the widened subject would
 * otherwise have lifted: off the decision path there is no park to hand back and no audience to
 * assert, so the answer is both-false however the issue is labelled. The criteria read then holds
 * the flip to a body a builder could grade cold — `ready-for:agent` over a body with no block parks
 * the lane at `build claim` exit 32 instead.
 */
const flipWrites = (
	labels: ReadonlyArray<string>,
	criteria: AcceptanceCriteriaRead,
): {readonly add: boolean; readonly remove: boolean} =>
	onDecisionPath(labels) && criteria._tag === "Found"
		? audienceWrites(labels)
		: {add: false, remove: false};

/** Why the flip was skipped, in the reader's own words plus the route that repairs the body. */
const skippedFlip = (
	issue: number,
	criteria: Exclude<AcceptanceCriteriaRead, {readonly _tag: "Found"}>,
): string =>
	criteria._tag === "Absent"
		? `${VERB}: the ruling marker stands, but #${issue} carries no acceptance-criteria block — ${criteria.reason}. ready-for:agent promises a builder can pick it up cold, so the audience was not flipped: author the block with \`fabrika triage enrich ${issue}\` and re-run.`
		: `${VERB}: the ruling marker stands, but #${issue}'s acceptance-criteria block is malformed — ${criteria.reason} (${criteria.evidence}). The audience was not flipped: repair a level drift with \`fabrika triage repair-criteria ${issue}\`, anything else with \`fabrika triage enrich ${issue}\`, then re-run.`;

/**
 * Where the founder's words are, in the one place that says which of the two they are.
 *
 * A union rather than two optional fields: "both given" and "neither given" are not states this verb
 * has an answer for, and the adapter refuses them at the flags rather than passing an ambiguity down.
 */
export type RulingSource<R = never> =
	/** A comment already on the issue, as an issue-comment URL. */
	| {readonly _tag: "Cited"; readonly cites: string}
	/** A file quoting the founder verbatim, which this verb posts and then cites. */
	| {
			readonly _tag: "Quoted";
			/** The `--authorization` path, carried for the refusal messages only. */
			readonly authorizationPath: string;
			readonly authorization: Effect.Effect<AuthorizationDocument, never, R>;
	  };

export interface RuleOptions<R = never> {
	readonly number: number;
	readonly ruling: RulingSource<R>;
	/**
	 * The 1-based body criterion this ruling replaces, or `null` where it replaces none.
	 *
	 * The position is the human's statement and the verb's only check is that the block has such a
	 * row: no verb can read a founder's prose and judge which criterion it overturns, and one that
	 * guessed would silently retire a row a reviewer still owes.
	 */
	readonly supersedes: number | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: () => Date;
}

export const runRule = <R = never>(
	options: RuleOptions<R>,
): Effect.Effect<VerbOutcome, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.number);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const source = options.ruling;
		const cited = source._tag === "Cited" ? citedRuling(source.cites, repo, options.number) : null;
		if (cited?._tag === "Refused") return cited.outcome;
		const quote =
			source._tag === "Quoted"
				? readAuthorization(
						VERB,
						"ruling",
						source.authorizationPath,
						yield* source.authorization,
						AUTHORIZATION_CODES,
					)
				: null;
		if (quote?._tag === "Refused") return quote.outcome;

		const target = yield* requireRulable(VERB, repo, options.number);
		if (target._tag === "Refused") return target.outcome;

		// Only the cited shape has a comment to locate: the quoted one posts its own, below.
		let citedNote: string | null = null;
		if (cited !== null) {
			const listed = yield* listComments(repo, options.number);
			if (listed._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the comments on #${options.number}: ${listed.reason} — whether the cited ruling is recorded there is UNKNOWN. Nothing was written.`,
				);
			}
			const ruling = listed.value.find((comment) => comment.id === cited.commentId);
			if (ruling === undefined) {
				return refuse(
					NO_TARGET,
					`${VERB}: comment ${cited.commentId} is not on #${options.number} — a ruling has to be recorded on the issue it rules.`,
				);
			}
			citedNote = `${VERB}: read ${listed.value.length} comment(s) on #${options.number}; the cited ruling is ${ruling.author}'s.`;
		}

		const viewer = yield* viewerLogin;
		if (viewer._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the invoking account: ${viewer.reason} — authority is UNKNOWN, never granted. Nothing was written.`,
			);
		}

		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${roster.reason} — whether ${viewer.value} may rule is UNKNOWN, neither authorized nor refused. Nothing was written.`,
			);
		}
		const notes = [
			`${VERB}: ${roster.logins.size} control-plane account(s) from ${roster.owners.join(", ") || "no owner"} at ${roster.ref}.`,
			citedNote ??
				`${VERB}: the ruling is quoted verbatim and posts as ${viewer.value}'s comment on #${options.number} — the marker binds the text, and no machine can prove the quote truthful.`,
		];
		if (roster.logins.size === 0) {
			return refuse(
				RULING_UNAUTHORIZED,
				`${VERB}: ${repo}'s CODEOWNERS names no control-plane owner at ${roster.ref}, so no account may rule a decision here.`,
				notes,
			);
		}
		if (!roster.logins.has(viewer.value)) {
			return refuse(
				RULING_UNAUTHORIZED,
				`${VERB}: ${viewer.value} is not on ${repo}'s control-plane roster at ${roster.ref} — refusing to record a ruling.`,
				notes,
			);
		}

		const issue = markedIssue(options.number);
		const derived = bodyDigest(target.issue.body);
		const digest = scopeDigest(derived);
		const at = stampOf(options.now());
		if (issue === null || digest === null || at === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot compose the ruling marker: the issue, the digest "${derived}" or the clock will not brand. Nothing was written.`,
				notes,
			);
		}

		const criteria = readCriteria(target.issue.body);
		let supersedes: CriterionIndex | null = null;
		if (options.supersedes !== null) {
			if (criteria._tag !== "Found") {
				return refuse(
					FAILED,
					`${VERB}: --supersedes ${options.supersedes} names a row of #${options.number}'s acceptance-criteria block and that block does not read — a ruling cannot replace a criterion nobody can point at. Nothing was written.`,
					notes,
				);
			}
			supersedes = criterionIndex(options.supersedes);
			if (supersedes === null || supersedes > criteria.value.length) {
				return refuse(
					FAILED,
					`${VERB}: --supersedes ${options.supersedes} is not a row of #${options.number}'s block, which has ${criteria.value.length} — the position is 1-based. Nothing was written.`,
					notes,
				);
			}
		}
		const audience = flipWrites(target.issue.labels, criteria);
		if (audience.add) {
			// Only the label this run would POST is guarded: it is the POST that mints an unknown
			// label, and a DELETE of a label the repo never defined removes nothing.
			const labels = yield* listLabels(repo);
			if (labels._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${repo}'s label taxonomy: ${labels.reason} — nothing was written.`,
					notes,
				);
			}
			if (!labels.value.includes(READY_FOR_AGENT)) {
				return refuse(
					NO_TARGET,
					`${VERB}: label "${READY_FOR_AGENT}" is absent from ${repo}'s taxonomy — refusing to create it.`,
					notes,
				);
			}
		}

		let url = cited?.url ?? null;
		if (quote !== null && quote._tag === "Quoted") {
			const authorization = yield* createComment(
				repo,
				options.number,
				authorizationBody(quote.text),
			);
			if (authorization._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the authorization write failed: ${authorization.reason} — it may or may not have landed and no marker was written, so nothing rules #${options.number}. Re-read the issue before retrying.`,
					notes,
				);
			}
			url = rulingUrl(commentUrl(repo, options.number, authorization.value.id));
			notes.push(
				`${VERB}: the quoted authorization landed as comment ${authorization.value.id}; the marker cites it.`,
			);
		}
		if (url === null) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the ruling comment does not brand as ${RULING_GRAMMAR} — the marker cannot cite it.`,
				notes,
			);
		}

		const body = emit({issue, digest, ruling: url, supersedes, at});
		const posted = yield* createComment(repo, options.number, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the marker write failed: ${posted.reason} — it may or may not have landed; re-read #${options.number} before retrying. The audience was not flipped.`,
				notes,
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (back._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the marker posted and could not be re-read — the outcome is UNKNOWN, so the audience was not flipped.`,
				notes,
			);
		}
		if (normalizeForReadback(back.value) !== normalizeForReadback(body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the marker posted but does not read back — the audience was not flipped, and the ruling needs a human eye.`,
				notes,
			);
		}
		// The audience answer belongs to the decision path only, so an issue off it is done at the
		// marker: no flip to make, no criteria block to require, and both labels left as found.
		if (!onDecisionPath(target.issue.labels)) {
			notes.push(
				`${VERB}: marker ${posted.value.id} posted and read back; #${options.number} is not ${DECISION_TYPE_LABEL}, so the audience was left exactly as it was found.`,
			);
			return answer(
				JSON.stringify({
					answer: "ruled",
					issue: options.number,
					digest: derived,
					ruling: url,
					supersedes,
					by: viewer.value,
					at,
					comment: posted.value.id,
					audience: null,
					observed: target.issue.labels,
				}),
				notes,
			);
		}
		if (criteria._tag !== "Found") {
			notes.push(`${VERB}: marker ${posted.value.id} posted and read back.`);
			return refuse(CRITERIA_REQUIRED, skippedFlip(options.number, criteria), notes);
		}
		notes.push(`${VERB}: marker ${posted.value.id} posted and read back; flipping the audience.`);

		if (audience.add) {
			const added = yield* addLabels(repo, options.number, [READY_FOR_AGENT]);
			if (added._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the marker stands but adding "${READY_FOR_AGENT}" failed: ${added.reason} — the audience is UNKNOWN; re-run to finish the flip.`,
					notes,
				);
			}
		}
		if (audience.remove) {
			const removed = yield* removeLabel(repo, options.number, READY_FOR_HUMAN);
			if (removed._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the marker stands but removing "${READY_FOR_HUMAN}" failed: ${removed.reason} — the audience is UNKNOWN; re-run to finish the flip.`,
					notes,
				);
			}
		}

		const reread = yield* getIssue(repo, options.number);
		if (reread._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the marker stands and #${options.number} could not be re-read — the audience is UNKNOWN, never asserted from intent.`,
				notes,
			);
		}
		const observed = reread.value.labels;
		if (!audienceSettled(observed)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the marker stands but the audience reads back as ${observed.filter((label) => label.startsWith("ready-for:")).join(", ") || "no ready-for: label"} — the flip did not settle.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				answer: "ruled",
				issue: options.number,
				digest: derived,
				ruling: url,
				supersedes,
				by: viewer.value,
				at,
				comment: posted.value.id,
				audience: READY_FOR_AGENT,
				observed,
			}),
			notes,
		);
	});
