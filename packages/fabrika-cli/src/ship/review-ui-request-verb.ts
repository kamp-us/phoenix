/**
 * `ship review-ui-request` — the operator-owned, at-most-once producer-event recovery.
 *
 * Unlike the generic zero-CI `ship nudge`, this verb tolerates unrelated checks. It binds a full
 * live head to a default-branch governed localhost harness, exhaustively reads every check run,
 * legacy status, and governed workflow run, and mutates only when the one declared evidence
 * check/run is positively absent. Pending, successful, failed, or ambiguous governed evidence all
 * refuse. The close/reopen event is verified on both legs and retains the loud may-be-closed exit.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {runsForWorkflow} from "../review-ui/ci-github.ts";
import {
	LOCALHOST_DECLARATIONS_PATH,
	type LocalhostHarnessDeclaration,
	parseLocalhostDeclarations,
} from "../review-ui/localhost-evidence.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	INCOMPLETE_SCAN,
	NUDGE_REOPEN_UNCONFIRMED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	PROVEN_NOT_IN_STATE,
	READBACK_MISMATCH,
	STALE_HEAD,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {
	commitShaAtRef,
	createShipComment,
	defaultBranch,
	getShipComment,
	listCommitStatuses,
	listShipCheckRuns,
	listShipComments,
	readFileAtRef,
	setPullState,
} from "./github.ts";
import {badNumber, resolvePull, resolveTargetRepo} from "./target.ts";

const VERB = "ship review-ui-request";
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface ReviewUiRequestOptions {
	readonly pr: number;
	readonly sha: string;
	readonly harness: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type TargetedEvidenceScan =
	| {
			readonly _tag: "Absent";
			readonly checks: number;
			readonly statuses: number;
			readonly runs: number;
	  }
	| {readonly _tag: "Unknown"; readonly what: string; readonly reason: string}
	| {readonly _tag: "Incomplete"; readonly reason: string}
	| {readonly _tag: "Present"; readonly reason: string};

const scanTargetedEvidence = (
	repo: string,
	pr: number,
	bound: string,
	authorityHead: string,
	harness: LocalhostHarnessDeclaration,
): Effect.Effect<TargetedEvidenceScan, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const checks = yield* listShipCheckRuns(repo, bound);
		if (checks._tag === "Failure") {
			return {
				_tag: "Unknown",
				what: `every check run at ${bound}`,
				reason: checks.reason,
			};
		}
		if (!checks.value.exhausted || checks.value.declared !== checks.value.runs.length) {
			return {
				_tag: "Incomplete",
				reason: `check-run enumeration returned ${checks.value.runs.length} of ${checks.value.declared} row(s), exhausted:${checks.value.exhausted} — refusing targeted absence over an incomplete scan`,
			};
		}
		const governedChecks = checks.value.runs.filter((row) => row.name === harness.check);
		if (governedChecks.length > 0) {
			const states = governedChecks
				.map((row) => `${row.status}/${row.conclusion ?? "null"}`)
				.join(", ");
			return {
				_tag: "Present",
				reason: `${governedChecks.length} ${harness.check} check row(s) already exist at ${bound}: ${states}`,
			};
		}

		const statuses = yield* listCommitStatuses(repo, bound);
		if (statuses._tag === "Failure") {
			return {
				_tag: "Unknown",
				what: `every commit status at ${bound}`,
				reason: statuses.reason,
			};
		}
		if (!statuses.value.exhausted) {
			return {
				_tag: "Incomplete",
				reason:
					"commit-status pagination never reached a terminal page — refusing targeted absence over a truncated history",
			};
		}
		const governedStatuses = statuses.value.statuses.filter((row) => row.context === harness.check);
		if (governedStatuses.length > 0) {
			return {
				_tag: "Present",
				reason: `${governedStatuses.length} ${harness.check} commit status row(s) already exist at the bound-head endpoint: ${governedStatuses.map((row) => `${row.state}@${row.sha}`).join(", ")}`,
			};
		}

		const runs = yield* runsForWorkflow(repo, harness.workflow);
		if (runs._tag !== "Ok") {
			return {
				_tag: "Unknown",
				what: `every ${harness.workflow} workflow run`,
				reason: `${runs._tag}: ${runs.reason}`,
			};
		}
		const currentHeadRuns = runs.value.filter(
			(row) =>
				row.path === harness.workflow &&
				row.event === harness.event &&
				row.repository === repo &&
				row.subjectHead === bound,
		);
		const expectedTitle = `review-ui localhost evidence / ${harness.id} / PR #${pr} / subject ${bound} / authority ${authorityHead}`;
		const exactRuns = currentHeadRuns.filter((row) => row.title === expectedTitle);
		if (exactRuns.length > 0) {
			return {
				_tag: "Present",
				reason: `${exactRuns.length} exact governed workflow run(s) already exist at ${bound}: ${exactRuns.map((row) => `${row.status}/${row.conclusion ?? "null"}`).join(", ")}`,
			};
		}
		if (currentHeadRuns.length > 0) {
			return {
				_tag: "Present",
				reason: `${currentHeadRuns.length} current-head governed-workflow run(s) do not bind the exact PR/head/authority title — evidence is ambiguous`,
			};
		}
		return {
			_tag: "Absent",
			checks: checks.value.declared,
			statuses: statuses.value.statuses.length,
			runs: runs.value.length,
		};
	});

export const runReviewUiRequest = (
	options: ReviewUiRequestOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, json} = options;
		const bad = badNumber(VERB, "a pull-request number", pr);
		if (bad !== null) return bad;
		if (!FULL_SHA.test(options.sha)) {
			return refuse(FAILED, `${VERB}: --sha must be the full lowercase 40-character head.`);
		}
		const bound = options.sha;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const unreadable = (what: string, reason: string): VerbOutcome =>
			refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${what}: ${reason} — targeted evidence absence is UNKNOWN; nothing was touched.`,
			);
		const notInState = (why: string): VerbOutcome =>
			refuse(
				PROVEN_NOT_IN_STATE,
				`${VERB}: #${pr} is not in the targeted review-ui evidence-request state (${why}) — refusing to touch it.`,
			);

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => unreadable(`PR #${pr}`, reason).stderr.at(-1) ?? reason,
		});
		if (target._tag === "Refused") return target.outcome;
		if (target.pull.headSha !== bound) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head is ${target.pull.headSha}, not ${bound} — the requested evidence belongs to another tree.`,
			);
		}
		if (target.pull.state !== "open") return notInState("the PR is not open");

		const base = yield* defaultBranch(repo);
		if (base._tag === "Failure") return unreadable("the default branch", base.reason);
		const authorityHead = yield* commitShaAtRef(repo, base.value);
		if (authorityHead._tag === "Failure") {
			return unreadable("the governed authority revision", authorityHead.reason);
		}
		const authority = yield* readFileAtRef(repo, LOCALHOST_DECLARATIONS_PATH, authorityHead.value);
		if (authority._tag === "Unknown") {
			return unreadable("the governed localhost declaration", authority.reason);
		}
		if (authority._tag === "Absent") {
			return notInState(`${LOCALHOST_DECLARATIONS_PATH} is absent at ${authorityHead.value}`);
		}
		const declarations = parseLocalhostDeclarations(authority.value);
		if (declarations._tag === "Malformed") {
			return notInState(`the governed localhost declaration is malformed: ${declarations.reason}`);
		}
		const harness = declarations.value.harnesses.find((row) => row.id === options.harness);
		if (harness === undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: "${options.harness}" is not a governed localhost-only harness.`,
			);
		}

		const routeScan = (scan: TargetedEvidenceScan): VerbOutcome | null => {
			switch (scan._tag) {
				case "Absent":
					return null;
				case "Unknown":
					return unreadable(scan.what, scan.reason);
				case "Incomplete":
					return refuse(INCOMPLETE_SCAN, `${VERB}: ${scan.reason}.`);
				case "Present":
					return notInState(scan.reason);
			}
		};
		const initialScan = yield* scanTargetedEvidence(repo, pr, bound, authorityHead.value, harness);
		const initialRefusal = routeScan(initialScan);
		if (initialRefusal !== null) return initialRefusal;

		const requestMarker = `<!-- fabrika:ship-review-ui-request head=${bound} harness=${harness.id} -->`;
		const priorComments = yield* listShipComments(repo, pr);
		if (priorComments._tag === "Failure") {
			return unreadable("the at-most-once request markers", priorComments.reason);
		}
		if (priorComments.value.some((comment) => comment.body.split("\n")[0] === requestMarker)) {
			return notInState(
				`head ${bound} already carries the ${harness.id} evidence-request marker — a second request is escalation, not retry`,
			);
		}

		const freshBase = yield* defaultBranch(repo);
		if (freshBase._tag === "Failure") {
			return unreadable("the default branch immediately before mutation", freshBase.reason);
		}
		if (freshBase.value !== base.value) {
			return notInState(`the default branch moved from ${base.value} to ${freshBase.value}`);
		}
		const freshAuthorityHead = yield* commitShaAtRef(repo, freshBase.value);
		if (freshAuthorityHead._tag === "Failure") {
			return unreadable(
				"the governed authority revision immediately before mutation",
				freshAuthorityHead.reason,
			);
		}
		if (freshAuthorityHead.value !== authorityHead.value) {
			return notInState(
				`the governed authority moved from ${authorityHead.value} to ${freshAuthorityHead.value}`,
			);
		}
		const freshTarget = yield* resolvePull(VERB, repo, pr);
		if (freshTarget._tag === "Refused") return freshTarget.outcome;
		if (freshTarget.pull.state !== "open") return notInState("the PR is no longer open");
		if (freshTarget.pull.headSha !== bound) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head moved from ${bound} to ${freshTarget.pull.headSha} before mutation — nothing was touched.`,
			);
		}

		const requestBody = `${requestMarker}\n\nOperator-owned governed review-ui evidence request.\n\n- Authority: ${authorityHead.value}\n- Workflow: ${harness.workflow}\n- Check: ${harness.check}`;
		const requestComment = yield* createShipComment(repo, pr, requestBody);
		if (requestComment._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the at-most-once request marker write is UNKNOWN (${requestComment.reason}) — no PR-state mutation was attempted.`,
			);
		}
		const requestReadback = yield* getShipComment(repo, requestComment.value.id);
		if (requestReadback._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the request marker cannot be read back (${requestReadback.reason}) — no PR-state mutation was attempted.`,
			);
		}
		if (requestReadback.value !== requestBody) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: request marker ${requestComment.value.id} does not read back as written — no PR-state mutation was attempted.`,
			);
		}
		const claimedComments = yield* listShipComments(repo, pr);
		if (claimedComments._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: cannot prove the at-most-once marker set after writing (${claimedComments.reason}) — no PR-state mutation was attempted.`,
			);
		}
		const claims = claimedComments.value.filter(
			(comment) => comment.body.split("\n")[0] === requestMarker,
		);
		if (claims.length !== 1 || claims[0]?.id !== requestComment.value.id) {
			return notInState(
				`the ${harness.id} request marker race resolved to ${claims.length} marker(s), not this one exclusively — no PR-state mutation was attempted`,
			);
		}

		const mutationBase = yield* defaultBranch(repo);
		if (mutationBase._tag === "Failure") {
			return unreadable("the default branch after the marker claim", mutationBase.reason);
		}
		if (mutationBase.value !== base.value) {
			return notInState(
				`the default branch moved from ${base.value} to ${mutationBase.value} after the marker claim`,
			);
		}
		const mutationAuthority = yield* commitShaAtRef(repo, mutationBase.value);
		if (mutationAuthority._tag === "Failure") {
			return unreadable(
				"the governed authority revision after the marker claim",
				mutationAuthority.reason,
			);
		}
		if (mutationAuthority.value !== authorityHead.value) {
			return notInState(
				`the governed authority moved from ${authorityHead.value} to ${mutationAuthority.value} after the marker claim`,
			);
		}
		const mutationTarget = yield* resolvePull(VERB, repo, pr);
		if (mutationTarget._tag === "Refused") return mutationTarget.outcome;
		if (mutationTarget.pull.state !== "open") {
			return notInState("the PR is no longer open after the marker claim");
		}
		if (mutationTarget.pull.headSha !== bound) {
			return refuse(
				STALE_HEAD,
				`${VERB}: the live head moved from ${bound} to ${mutationTarget.pull.headSha} after the marker claim — no PR-state mutation was attempted.`,
			);
		}
		const mutationScan = yield* scanTargetedEvidence(
			repo,
			pr,
			bound,
			mutationAuthority.value,
			harness,
		);
		const mutationRefusal = routeScan(mutationScan);
		if (mutationRefusal !== null) return mutationRefusal;
		if (mutationScan._tag !== "Absent") {
			return unreadable("the final targeted evidence scan", "its closed result did not narrow");
		}

		yield* setPullState(repo, pr, "closed");
		const afterClose = yield* resolvePull(VERB, repo, pr);
		if (afterClose._tag === "Refused" || afterClose.pull.state !== "closed") {
			if (afterClose._tag !== "Refused" && afterClose.pull.state === "open") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: the close did not read back closed; #${pr} is confirmed open and no request is claimed.`,
				);
			}
			const safetyReopen = yield* setPullState(repo, pr, "open");
			const safetyRead = yield* resolvePull(VERB, repo, pr);
			if (safetyRead._tag === "Refused" || safetyRead.pull.state !== "open") {
				const why =
					safetyReopen._tag === "Failure"
						? safetyReopen.reason
						: "the safety read-back does not show it open";
				return refuse(
					NUDGE_REOPEN_UNCONFIRMED,
					`${VERB}: the close outcome is UNKNOWN and the safety reopen is UNCONFIRMED: ${why} — PR #${pr} may be CLOSED. Reopen it by hand now.`,
				);
			}
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the close outcome is UNKNOWN, but the safety reopen is confirmed — no evidence request is claimed.`,
			);
		}
		const movedDuringClose = afterClose.pull.headSha !== bound;

		const reopened = yield* setPullState(repo, pr, "open");
		const afterOpen = yield* resolvePull(VERB, repo, pr);
		if (afterOpen._tag === "Refused" || afterOpen.pull.state !== "open") {
			const why =
				reopened._tag === "Failure" ? reopened.reason : "the read-back does not show it open";
			return refuse(
				NUDGE_REOPEN_UNCONFIRMED,
				`${VERB}: the close landed and the reopen is UNCONFIRMED: ${why} — PR #${pr} may be CLOSED. Reopen it by hand now.`,
			);
		}
		if (movedDuringClose || afterOpen.pull.headSha !== bound) {
			return refuse(
				STALE_HEAD,
				`${VERB}: PR #${pr} moved away from ${bound} during the close/reopen event; the reopen is confirmed, but no evidence request is claimed for the new head.`,
			);
		}

		const result = {
			outcome: "requested",
			sha: bound,
			harness: harness.id,
			checks: mutationScan.checks,
			statuses: mutationScan.statuses,
			runs: mutationScan.runs,
		};
		return json
			? answer(JSON.stringify(result))
			: answer(
					`requested\t${bound}\t${harness.id}\tchecks:${result.checks}\tstatuses:${result.statuses}\truns:${result.runs}`,
				);
	});
