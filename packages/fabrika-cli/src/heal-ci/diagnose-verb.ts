/**
 * `heal-ci diagnose` — one PR's stall class, with the evidence that proves it.
 *
 * The classification itself is `./stall.ts`, pure and ordered; this module is the read set it runs
 * over and the line grammar it prints. Every read splits proven-absent from could-not-read, and a
 * read that could not complete is `11` or `13` — **never** a class, and never `attended`.
 *
 * The reads are exposed as {@link diagnoseOne} so `heal-ci sweep` classifies through this same chain
 * rather than a second one.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type Producer, producerFor, resolveCi} from "../config/ci-producer.ts";
import type {Resolution} from "../config/key-group.ts";
import type {CiSurface} from "../config/keys/ci.ts";
import {governedRootsOr} from "../config/paths.ts";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {
	commitExists,
	getPullRequest,
	listPullFiles,
	type PullRecord,
	permissionFor,
} from "../io/pulls.ts";
import {partitionWithUi, shipNamespacesOf, touchesGovernanceRoot} from "../review/classes.ts";
import {isInformational, isStalled, rollupOf, statusOf} from "../review/rollup.ts";
import {inForce} from "../ship/gate-verb.ts";
import {
	behindBase,
	countWorkflowRuns,
	latestPerContext,
	listReviews,
	listShipCheckRuns,
	listWorkflows,
	pullTimeline,
	type ShipCheckRun,
} from "../ship/github.ts";
import {queueStateOf} from "../ship/queue.ts";
import {
	badNumber,
	inspectedSha,
	NULL_TOKEN,
	prefixMatch,
	resolveTargetRepo,
} from "../ship/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readMarker} from "../wire/verdict-marker.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {commitPushedAt} from "./github.ts";
import {type Link, linkOf, renderLink} from "./link.ts";
import {type CiToken, classifyStall, type StallToken, strandAgeMinutes} from "./stall.ts";
import {compare, readDeclared} from "./surface.ts";

const VERB = "heal-ci diagnose";

/** The permission levels ADR 0055 counts as an authorized verdict author. */
const AUTHORIZED = new Set(["admin", "maintain", "write"]);

export interface DiagnoseParams {
	readonly dwellMinutes: number;
	readonly wedgeDwellMinutes: number;
	readonly driftCommits: number;
	readonly now: number;
}

export interface DiagnoseOptions extends DiagnoseParams {
	readonly pr: number;
	/** Empty means "the live head" — an explicit value is bound and refused if it is not on the PR. */
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Diagnosis {
	readonly pr: number;
	readonly token: StallToken;
	readonly head: string;
	readonly ageMinutes: number;
	readonly owner: {
		readonly login: string | null;
		readonly claimedAt: string | null;
		readonly lastActivityAt: string | null;
	};
	readonly gates: {readonly state: string; readonly pass: number; readonly required: number};
	readonly ci: {readonly rollup: CiToken; readonly contexts: number};
	readonly queue: string;
	readonly link: Link;
	readonly scanned: {readonly comments: number; readonly checks: number};
	readonly behindBase: number;
	readonly notices: ReadonlyArray<string>;
}

export type DiagnoseResult =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	/** The PR closed or merged between a sweep's list read and its classification. */
	| {readonly _tag: "Gone"}
	| {readonly _tag: "Diagnosis"; readonly diagnosis: Diagnosis};

const unreadable = (what: string, forPr: number, reason: string): string =>
	`${VERB}: cannot read ${what} for #${forPr}: ${reason} — the stall class is UNKNOWN, never "attended".`;

const short = (received: number, declared: number, noun: string): string =>
	`${VERB}: received ${received} of ${declared} declared ${noun} — refusing to classify over a truncated read.`;

/**
 * The CI token, with the two zero-signal states kept apart as the distinct facts they are.
 *
 * The zero-workflow reading is `../config/ci-producer.ts`'s, not this module's: `review ci` and
 * `ship checks` both route the producer question through `producerFor`, and a third compiled-in
 * answer here would hand a repo that never declared `ci.noProducer` the opt-out those two verbs
 * make it declare. `none` is the degrade token, so it is emitted only where the repo asked for it;
 * the two producer arms that are not an answer come back as a refusal for the caller to carry.
 */
const ciTokenOf = (
	runs: ReadonlyArray<ShipCheckRun>,
	producer: Producer,
	runCount: number,
	wedged: boolean,
): CiToken | {readonly refusal: Extract<Producer, {readonly reason: string}>} => {
	if (wedged) return "wedged";
	if (runs.length > 0) return rollupOf(runs);
	if (producer._tag === "OptedOut") return "none";
	if (producer._tag === "Present") return runCount === 0 ? "no-runs" : "pending";
	return {refusal: producer};
};

/**
 * One PR's whole classification.
 *
 * The reads are sequential on purpose: each refusal names what it could not read, and a parallel
 * read would have to invent a precedence between two simultaneous faults.
 */
export const diagnoseOne = (
	repo: string,
	pr: number,
	sha: string,
	params: DiagnoseParams,
	/** This repo's `governedRoots`, resolved once by the caller — a sweep reads the config once. */
	governedRoots: ReadonlyArray<string>,
	/** This repo's `ci`, resolved once by the caller for the same reason. */
	ci: Resolution<CiSurface>,
): Effect.Effect<DiagnoseResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const notices: string[] = [];

		// Read directly rather than through `resolvePull`: a 404 here is `Gone`, which a sweep counts as
		// scanned-but-not-stalled and a direct call turns into its own `7` refusal.
		const found = yield* getPullRequest(repo, pr);
		if (found._tag === "Absent") return {_tag: "Gone" as const};
		if (found._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(PRECONDITION_UNKNOWN, unreadable("the pull request", pr, found.reason)),
			};
		}
		const pull: PullRecord = found.value;

		const bound = sha === "" ? pull.headSha : sha;
		if (sha !== "") {
			const at = yield* commitExists(repo, sha);
			if (at._tag === "Absent") {
				return {
					_tag: "Refused" as const,
					outcome: refuse(
						ZERO_SCOPE,
						`${VERB}: no commit ${sha} on PR #${pr} — refusing to classify a tree this PR never had.`,
					),
				};
			}
			if (at._tag === "Unknown") {
				return {
					_tag: "Refused" as const,
					outcome: refuse(PRECONDITION_UNKNOWN, unreadable("the commit", pr, at.reason)),
				};
			}
			if (!prefixMatch(pull.headSha, sha)) {
				notices.push(
					`${VERB}: the live head is ${pull.headSha}, you are diagnosing ${sha} — the head moved.`,
				);
			}
		}

		const refused = (code: number, reason: string): DiagnoseResult => ({
			_tag: "Refused" as const,
			outcome: refuse(code, reason, notices),
		});

		const filed = yield* listPullFiles(repo, pr);
		if (filed._tag === "Failure") {
			return refused(PRECONDITION_UNKNOWN, unreadable("the changed files", pr, filed.reason));
		}
		if (filed.value.length < pull.changedFiles) {
			return refused(
				INCOMPLETE_SCAN,
				short(filed.value.length, pull.changedFiles, "changed files"),
			);
		}

		const enumerated = yield* listShipCheckRuns(repo, bound);
		if (enumerated._tag === "Failure") {
			return refused(PRECONDITION_UNKNOWN, unreadable("the check runs", pr, enumerated.reason));
		}
		if (enumerated.value.runs.length < enumerated.value.declared) {
			return refused(
				INCOMPLETE_SCAN,
				short(enumerated.value.runs.length, enumerated.value.declared, "check runs"),
			);
		}
		const gating = latestPerContext(enumerated.value.runs).filter(
			(run) => !isInformational(run.name),
		);

		const workflows = yield* listWorkflows(repo);
		if (workflows._tag === "Failure") {
			return refused(
				PRECONDITION_UNKNOWN,
				unreadable("the workflow inventory", pr, workflows.reason),
			);
		}
		const runCount = yield* countWorkflowRuns(repo, bound);
		if (runCount._tag === "Failure") {
			return refused(PRECONDITION_UNKNOWN, unreadable("the workflow runs", pr, runCount.reason));
		}

		const pushedAt = yield* commitPushedAt(repo, bound);
		if (pushedAt._tag === "Failure") {
			return refused(PRECONDITION_UNKNOWN, unreadable("the head commit", pr, pushedAt.reason));
		}
		// A single check-run read carries no queue-entry stamp, so the dwell is measured from the head
		// push: a gating check that never started since the head landed is what "wedged" observes.
		const headAgeMinutes = strandAgeMinutes(pushedAt.value, null, params.now);
		const stranded = gating.filter(isStalled).map((run) => run.name);
		const wedged = stranded.length > 0 && headAgeMinutes >= params.wedgeDwellMinutes;
		if (stranded.length > 0) {
			notices.push(
				`${VERB}: stranded past the dwell: ${stranded.join(", ")} — the cancel-and-rerun lever is an operator's (#3999).`,
			);
		}

		const declared = yield* readDeclared(repo, pull.baseRef);
		if (declared._tag === "Unknown") {
			return refused(PRECONDITION_UNKNOWN, unreadable(declared.what, pr, declared.reason));
		}
		if (declared._tag === "Incomplete") {
			return refused(
				INCOMPLETE_SCAN,
				`${VERB}: the ruleset read never reached a terminal page — pagination is unexhausted; refusing to classify.`,
			);
		}
		// A permission the token lacks must never read as a surface that is clean, so arm 3 is skipped
		// rather than passed and the chain continues at arm 4.
		const surfaceGap =
			declared._tag === "Unprobeable" ? null : compare(declared.contexts, gating).token === "gap";
		if (declared._tag === "Unprobeable") {
			notices.push(
				`${VERB}: cannot read ${pull.baseRef}'s protection surface at this token's permission — the check-surface axis is UNPROBEABLE, so arm 3 is skipped, never passed.`,
			);
		}

		const commented = yield* listComments(repo, pr);
		if (commented._tag === "Failure") {
			return refused(PRECONDITION_UNKNOWN, unreadable("the comments", pr, commented.reason));
		}
		if (commented.value.length < pull.comments) {
			return refused(INCOMPLETE_SCAN, short(commented.value.length, pull.comments, "comments"));
		}

		const timeline = yield* pullTimeline(repo, pr);
		if (timeline._tag === "Failure") {
			return refused(PRECONDITION_UNKNOWN, unreadable("the timeline", pr, timeline.reason));
		}
		if (!timeline.value.exhausted) {
			return refused(
				INCOMPLETE_SCAN,
				`${VERB}: the timeline read never reached a terminal page — pagination is unexhausted, so a queue entry could sit on a page nobody read; refusing to classify.`,
			);
		}

		const reviewed = yield* listReviews(repo, pr);
		if (reviewed._tag === "Failure") {
			return refused(PRECONDITION_UNKNOWN, unreadable("the reviews", pr, reviewed.reason));
		}
		if (!reviewed.value.exhausted) {
			return refused(
				INCOMPLETE_SCAN,
				`${VERB}: the review read never reached a terminal page — pagination is unexhausted; refusing to classify.`,
			);
		}

		const drift = yield* behindBase(repo, pull.baseRef, bound);
		if (drift._tag === "Failure") {
			return refused(PRECONDITION_UNKNOWN, unreadable("the base comparison", pr, drift.reason));
		}

		const required = shipNamespacesOf(partitionWithUi(filed.value, governedRoots));
		const authorized = new Map<string, boolean>();
		const candidates: Array<{
			readonly namespace: string;
			readonly polarity: "PASS" | "FAIL";
			readonly sha: string;
			readonly content: string | null;
			readonly carrier: "marker";
			readonly stamp: string;
			readonly commentId: number;
		}> = [];
		for (const comment of commented.value as ReadonlyArray<CommentRecord>) {
			const marker = readMarker(comment.body);
			if (marker._tag !== "Found") continue;
			if (!authorized.has(comment.author)) {
				const permission = yield* permissionFor(repo, comment.author);
				if (permission._tag === "Unknown") {
					return refused(
						PRECONDITION_UNKNOWN,
						unreadable(`the ACL for ${comment.author}`, pr, permission.reason),
					);
				}
				authorized.set(
					comment.author,
					permission._tag === "Present" && AUTHORIZED.has(permission.value),
				);
			}
			if (authorized.get(comment.author) !== true) continue;
			candidates.push({
				namespace: marker.value.namespace,
				polarity: marker.value.polarity,
				sha: marker.value.sha,
				content: marker.value.content,
				carrier: "marker",
				stamp: comment.updatedAt,
				commentId: comment.id,
			});
		}
		const passes = required.filter((name) => {
			const winner = inForce(
				candidates.filter((claim) => claim.namespace === name),
				bound,
			);
			return winner !== null && winner.polarity === "PASS" && prefixMatch(winner.sha, bound);
		}).length;

		const link = linkOf(pull.body);
		const linkageRefused =
			required.length > 0 && link.kind === "other" && !pull.draft && pull.state === "open";

		// Arm 6, REST-only: the contract's unresolved-thread half has no REST form and the group takes
		// no GraphQL carve, so what is derivable is a live CHANGES_REQUESTED review — the contract's
		// non-`Bot` qualifier scopes the thread clause, not this one — and a control-plane diff with no
		// approval at this head. The narrowing is disclosed at runtime below, the way arm 3's skip is:
		// a half-evaluated axis a caller cannot see is indistinguishable from one that passed.
		notices.push(
			`${VERB}: the unresolved-thread clause has no REST form under this group's no-GraphQL rule — that half of the arm-6 axis is UNIMPLEMENTED, so blocked-human is derived from reviews alone, never from threads.`,
		);
		const decisive = reviewed.value.reviews
			.filter((review) => prefixMatch(review.commitId, bound))
			.filter((review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
			.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
		const byAuthor = new Map<string, string>();
		for (const review of decisive)
			if (!byAuthor.has(review.login)) byAuthor.set(review.login, review.state);
		const changesRequested = [...byAuthor.values()].includes("CHANGES_REQUESTED");
		const controlPlane = touchesGovernanceRoot(filed.value, governedRoots);
		const approved = [...byAuthor.values()].includes("APPROVED");
		const humanBlocked = changesRequested || (controlPlane && !approved);

		const lastActivityAt = pull.updatedAt === "" ? null : pull.updatedAt;
		const owner = pull.assignees[0] ?? null;
		const claimedAt =
			timeline.value.events.filter((event) => event.event === "assigned").at(-1)?.createdAt ?? null;
		const ownerIdleMinutes =
			owner === null || lastActivityAt === null
				? null
				: strandAgeMinutes(null, lastActivityAt, params.now);

		const token = ciTokenOf(
			gating,
			producerFor(VERB, repo, workflows.value, ci),
			runCount.value,
			wedged,
		);
		if (typeof token !== "string") {
			return refused(
				token.refusal._tag === "Unknown" ? PRECONDITION_UNKNOWN : ZERO_SCOPE,
				token.refusal.reason,
			);
		}
		const failingOrStranded =
			token === "wedged"
				? stranded.length
				: gating.filter((run) => run.status === "completed" && statusOf(run) !== "success").length;

		const queue = queueStateOf(timeline.value.events);
		const verdict = classifyStall({
			open: pull.state === "open" && !pull.draft && !pull.merged,
			wedged,
			surfaceGap,
			ci: token,
			linkageRefused,
			humanBlocked,
			hasOwner: owner !== null,
			ownerIdleMinutes,
			behindBase: drift.value,
			queued: queue === "queued",
			mergeIntentArmed: pull.autoMerge,
			gatesSatisfied: passes === required.length,
			dwellMinutes: params.dwellMinutes,
			driftCommits: params.driftCommits,
		});
		if (verdict.staleReason !== null) {
			notices.push(
				`${VERB}: claim-stale fired on ${verdict.staleReason} — last activity ${lastActivityAt ?? NULL_TOKEN}, behind base ${drift.value}.`,
			);
		}

		return {
			_tag: "Diagnosis" as const,
			diagnosis: {
				pr,
				token: verdict.token,
				head: bound,
				ageMinutes: strandAgeMinutes(pushedAt.value, lastActivityAt, params.now),
				owner: {login: owner, claimedAt, lastActivityAt},
				gates: {
					state:
						required.length === 0
							? "none-required"
							: passes === required.length
								? "satisfied"
								: "blocked",
					pass: passes,
					required: required.length,
				},
				ci: {rollup: token, contexts: failingOrStranded},
				queue,
				link,
				scanned: {comments: commented.value.length, checks: gating.length},
				behindBase: drift.value,
				notices,
			},
		};
	});

const nullable = (value: string | null): string => value ?? NULL_TOKEN;

export const renderDiagnosis = (found: Diagnosis, json: boolean): VerbOutcome =>
	json
		? answer(
				JSON.stringify({
					outcome: "stall",
					token: found.token,
					head: found.head,
					ageMinutes: found.ageMinutes,
					owner: found.owner,
					gates: {state: found.gates.state, pass: found.gates.pass, required: found.gates.required},
					ci: {rollup: found.ci.rollup, contexts: found.ci.contexts},
					queue: found.queue,
					link: {kind: found.link.kind, number: found.link.number},
					scanned: found.scanned,
					behindBase: found.behindBase,
				}),
				found.notices,
			)
		: answer(
				[
					`stall\t${found.token}\t${found.head}\t${found.ageMinutes}`,
					`owner\t${nullable(found.owner.login)}\t${nullable(found.owner.claimedAt)}\t${nullable(found.owner.lastActivityAt)}`,
					`gates\t${found.gates.state}\t${found.gates.pass}/${found.gates.required}`,
					`ci\t${found.ci.rollup}\t${found.ci.contexts}`,
					`queue\t${found.queue}`,
					`link\t${renderLink(found.link)}`,
					`facts\tscanned-comments:${found.scanned.comments}\tscanned-checks:${found.scanned.checks}\tbehind-base:${found.behindBase}`,
				].join("\n"),
				found.notices,
			);

export const runDiagnose = (
	options: DiagnoseOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "a pull-request number", options.pr);
		if (bad !== null) return bad;
		if (options.sha !== "") {
			const bound = inspectedSha(VERB, options.sha);
			if (typeof bound !== "string") return bound;
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const governed = yield* governedRootsOr(
			VERB,
			options.cwd,
			'the required namespace set and the §CP flag are UNKNOWN, never "attended".',
		);
		if (governed._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, governed.message);

		const result = yield* diagnoseOne(
			resolved.repo,
			options.pr,
			options.sha,
			options,
			governed.roots,
			yield* resolveCi(options.cwd),
		);
		if (result._tag === "Refused") return result.outcome;
		// `Gone` is only reachable from a sweep, whose list read and classification are separated in
		// time; a direct call resolves the PR once and a 404 there is already the `7` refusal.
		if (result._tag === "Gone") {
			return refuse(ZERO_SCOPE, `${VERB}: PR #${options.pr} not found in ${resolved.repo}.`);
		}
		return renderDiagnosis(result.diagnosis, options.json);
	});
